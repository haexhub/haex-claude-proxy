#!/usr/bin/env node
/**
 * haex-claude-proxy — Anthropic-API-compatible HTTP server that wraps the
 * `claude` CLI as a subprocess. Lets any Anthropic-API client (e.g.
 * hermes-agent) consume a Claude Pro/Max subscription via OAuth tokens
 * instead of a paid API key.
 *
 *   client (--provider              this proxy                   claude CLI
 *           anthropic +                                          (uses OAuth)
 *           ANTHROPIC_BASE_URL=
 *           http://this:8080)       POST /v1/messages    →       api.anthropic.com
 *               ↓ HTTP                  ↓ subprocess
 *               POST /v1/messages   ←   claude --print …
 *                                       (json or stream-json)
 *
 * Endpoints:
 *   POST /v1/messages   Anthropic Messages API. Translates Anthropic body to
 *                       a `claude` invocation and translates the response back.
 *                       Tools defined in the request are passed through as
 *                       `tool_use` content blocks; the model returns intents,
 *                       claude (run with `--allowed-tools ""`) does NOT execute
 *                       them — execution stays with the original caller.
 *   GET  /v1/models     Static list of OAuth-account-available models. Claude
 *                       Code 2.1+ probes this on startup; without it every
 *                       `--model X` fails with a misleading "may not exist"
 *                       error. List is hardcoded (or PROXY_AVAILABLE_MODELS
 *                       env override) — the public endpoint requires an API
 *                       key and isn't reachable from OAuth credentials.
 *   GET  /v1/models/{id} Single-model lookup against the same list.
 *   GET  /healthz       Liveness check + a synthetic `claude --version`.
 *
 * Auth (pluggable resolver — see src/resolvers/):
 *   - PROXY_RESOLVER picks the resolver implementation at boot
 *     (default: 'file'). Builtins: 'file', 'token-map'. Any other
 *     value is loaded as an npm module (e.g. the separate
 *     `haex-claude-proxy-resolver-pg` package for multi-tenant
 *     Postgres + AES-GCM).
 *   - The resolver owns request → credentials mapping. The server
 *     just stages the HOME the resolver returns, spawns claude, and
 *     calls resolver.writeback() after exit so refreshed tokens can
 *     be persisted.
 *   - When the resolver returns `persistent: true`, HOME is treated
 *     as its persistent store and the server skips the post-spawn
 *     `rm -rf` step (otherwise the next request would 503).
 *
 * Streaming: when the request has `stream: true`, the proxy spawns claude
 * with `--output-format stream-json --include-partial-messages` and pipes the
 * native Anthropic SSE events claude emits straight back to the caller.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
  validateMessagesBody,
  anthropicMessagesToPrompt,
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
  openAIBodyToAnthropic,
  anthropicToOpenAIResponse,
} from "./cli-format.js";
import { createResolver } from "./resolvers/index.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// Models advertised on GET /v1/models. Claude Code 2.1+ probes this endpoint
// at startup; if it returns 404 or an empty list, every `--model X` invocation
// fails with the misleading "selected model may not exist" error — even for
// models the OAuth account actually has access to.
//
// We serve a static list because the proxy is OAuth-only and the per-account
// model entitlements aren't reachable via the public /v1/models endpoint
// (which requires an API key). Override with PROXY_AVAILABLE_MODELS as a
// comma-separated list of `id` or `id:Display Name` entries.
const DEFAULT_AVAILABLE_MODELS = [
  { id: "claude-opus-4-7",   display_name: "Claude Opus 4.7",   created_at: "2026-04-15T00:00:00Z" },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6", created_at: "2026-03-04T00:00:00Z" },
  { id: "claude-haiku-4-5",  display_name: "Claude Haiku 4.5",  created_at: "2025-12-09T00:00:00Z" },
];

const AVAILABLE_MODELS = (() => {
  const raw = (process.env.PROXY_AVAILABLE_MODELS ?? "").trim();
  if (!raw) return DEFAULT_AVAILABLE_MODELS;
  const now = new Date().toISOString();
  return raw.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [id, ...labelParts] = entry.split(":");
    return {
      id: id.trim(),
      display_name: labelParts.join(":").trim() || id.trim(),
      created_at: now,
    };
  });
})();

// Resolver picked at boot via PROXY_RESOLVER (default: 'file'). The
// dispatcher's create() is async because resolvers may do I/O at
// startup (read a token map, connect a pool). Errors here surface
// before the HTTP server starts listening — fail-fast on bad config.
const resolver = await createResolver(process.env);
console.log(`[haex-claude-proxy] resolver=${resolver.name}`);

// Env handed to every spawned `claude`. We strip the parent's HOME
// here so that handlers MUST resolve a per-request HOME — no
// "leaking" the container's default user dir.
const SUBPROCESS_ENV_BASE = (() => {
  const e = { ...process.env };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  delete e.HOME;
  return e;
})();

/**
 * After the spawned `claude` exits, give the resolver a chance to
 * persist a refreshed token (if it changed), then `rm -rf` the
 * staged HOME — EXCEPT when the resolver returned `persistent: true`,
 * which means HOME is its persistent store and wiping it would 503
 * the next request.
 */
async function postSpawnCleanup(ctx) {
  const credPath = path.join(ctx.home, ".claude", ".credentials.json");
  let refreshed = null;
  try {
    refreshed = await fsp.readFile(credPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[proxy] refresh-readback failed:", e.message);
    }
  }
  if (refreshed && typeof resolver.writeback === "function") {
    try {
      await resolver.writeback(ctx, refreshed);
    } catch (e) {
      console.error("[proxy] resolver writeback failed:", e.message);
    }
  }
  if (!ctx.persistent) {
    await fsp.rm(ctx.home, { recursive: true, force: true }).catch(() => {});
  }
}

function envForHome(home) {
  return { ...SUBPROCESS_ENV_BASE, HOME: home };
}

const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Strip the query string before routing — Anthropic clients append things
  // like `?beta=true` and our handlers don't care about them. Without this
  // every request with a query string falls through to the catch-all 404,
  // which Claude Code surfaces as the misleading "selected model may not
  // exist" error.
  const pathname = req.url.split("?", 1)[0];

  if (req.method === "GET" && pathname === "/healthz") {
    return handleHealthz(res);
  }
  if (req.method === "POST" && pathname === "/v1/messages") {
    return handleMessages(req, res);
  }
  if (req.method === "POST" && (pathname === "/v1/chat/completions" || pathname === "/chat/completions")) {
    return handleChatCompletions(req, res);
  }
  if (req.method === "GET" && pathname === "/v1/models") {
    return handleListModels(req, res);
  }
  if (req.method === "GET" && pathname.startsWith("/v1/models/")) {
    return handleGetModel(req, res, decodeURIComponent(pathname.slice("/v1/models/".length)));
  }

  // Catch-all logger so we can spot any other startup probes Claude Code
  // emits that we still need to mock — useful while the proxy's coverage
  // of the Anthropic API surface is incomplete.
  console.log("[proxy] 404 %s %s", req.method, req.url);
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "not_found", message: `${req.method} ${req.url}` } }));
});

server.listen(PORT, HOST, () => {
  console.log(`[haex-claude-proxy] listening on http://${HOST}:${PORT}`);
});

// ────────────────────────────────────────────────────────────────────────────
// /healthz
// ────────────────────────────────────────────────────────────────────────────

function handleHealthz(res) {
  // `--version` doesn't read credentials, so HOME doesn't matter.
  // We point at /tmp anyway so the spawned process never resolves
  // anything outside the container.
  const proc = spawn(CLAUDE_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: envForHome("/tmp") });
  let out = "";
  let err = "";
  proc.stdout.on("data", (c) => { out += c.toString(); });
  proc.stderr.on("data", (c) => { err += c.toString(); });
  proc.on("error", (e) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  });
  proc.on("close", (code) => {
    if (code === 0) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, claudeVersion: out.trim() }));
    } else {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, exitCode: code, stderr: err.trim() }));
    }
  });
}

// ────────────────────────────────────────────────────────────────────────────
// GET /v1/models  /  GET /v1/models/{id}
// ────────────────────────────────────────────────────────────────────────────

// The list is static and not per-account, so we serve it without
// invoking the resolver. This also keeps the model probe usable in
// configurations where the resolver would 503 (e.g. file resolver
// without PROXY_CREDENTIALS_HOME).
function handleListModels(req, res) {
  const data = AVAILABLE_MODELS.map((m) => ({ type: "model", ...m }));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  }));
}

function handleGetModel(req, res, id) {
  const m = AVAILABLE_MODELS.find((x) => x.id === id);
  if (!m) {
    return errorResponse(res, 404, "not_found_error", `model not found: ${id}`);
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "model", ...m }));
}

// ────────────────────────────────────────────────────────────────────────────
// Anthropic api_key forwarding
//
// When the resolved credential is `mode='api_key'` we don't spawn the claude
// CLI — the request is forwarded directly to api.anthropic.com (or a
// per-credential override base URL) with the decrypted key in `x-api-key`.
// This is the V2 closure for api_key mode: the agent container never sees
// the upstream key, only the runner_session token.
// ────────────────────────────────────────────────────────────────────────────

const ANTHROPIC_API_VERSION =
  process.env.ANTHROPIC_API_VERSION ?? "2023-06-01";
const ANTHROPIC_DEFAULT_BASE = "https://api.anthropic.com";

// Hosts the proxy is allowed to forward an api_key credential to.
// `cred.baseUrl` (set by the tenant in the credential row) flows into
// this resolver — without an allowlist a malicious tenant could point
// it at `http://attacker.example` and exfiltrate their own decrypted
// upstream key via the `x-api-key` header. Override / extend via
// PROXY_ALLOWED_FORWARD_HOSTS as a comma-separated host list.
const DEFAULT_ALLOWED_FORWARD_HOSTS = new Set(["api.anthropic.com"]);
const ALLOWED_FORWARD_HOSTS = (() => {
  const raw = (process.env.PROXY_ALLOWED_FORWARD_HOSTS ?? "").trim();
  if (!raw) return DEFAULT_ALLOWED_FORWARD_HOSTS;
  const set = new Set(DEFAULT_ALLOWED_FORWARD_HOSTS);
  for (const h of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    set.add(h);
  }
  return set;
})();

// Hard upstream timeout — protects against slow / hung Anthropic
// responses tying up a proxy worker indefinitely. Tunable via env in
// case a deploy needs a longer budget.
const UPSTREAM_TIMEOUT_MS = Number(process.env.PROXY_UPSTREAM_TIMEOUT_MS ?? 120_000);

function resolveForwardTarget(rawBase) {
  let parsed;
  try {
    parsed = new URL(rawBase || ANTHROPIC_DEFAULT_BASE);
  } catch {
    return { error: `invalid base URL: ${rawBase}` };
  }
  if (parsed.protocol !== "https:") {
    return { error: `forward target must be https, got ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_FORWARD_HOSTS.has(host)) {
    return {
      error: `host '${host}' is not in PROXY_ALLOWED_FORWARD_HOSTS - refusing to forward`,
    };
  }
  // Drop trailing slashes / paths beyond the origin so we always hit
  // `/v1/messages` on the resolved host regardless of how the tenant
  // wrote their baseUrl.
  return { url: `${parsed.origin}/v1/messages` };
}

async function forwardAnthropicMessages(req, res, body, ctx) {
  const targetResolution = resolveForwardTarget(ctx.baseUrl);
  if (targetResolution.error) {
    return errorResponse(
      res,
      400,
      "invalid_request_error",
      targetResolution.error,
    );
  }
  const target = targetResolution.url;
  const headers = {
    "content-type": "application/json",
    "x-api-key": ctx.apiKey,
    "anthropic-version":
      req.headers["anthropic-version"] || ANTHROPIC_API_VERSION,
    accept: body.stream === true ? "text/event-stream" : "application/json",
  };
  const beta = req.headers["anthropic-beta"];
  if (typeof beta === "string" && beta) headers["anthropic-beta"] = beta;

  console.log(
    "[proxy] forward api_key model=%s stream=%s target=%s",
    body.model,
    body.stream === true,
    target,
  );

  // Three abort triggers feed one AbortController:
  //   1. hard timeout — caps how long we wait on the upstream.
  //   2. client disconnect — agent went away, no point keeping the
  //      upstream open and burning tokens.
  //   3. error in our own loop — propagate to upstream so it can stop.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("upstream timeout")), UPSTREAM_TIMEOUT_MS);
  const onClientClose = () => controller.abort(new Error("client disconnect"));
  req.on("close", onClientClose);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    req.off("close", onClientClose);
    const isAbort = e.name === "AbortError";
    return errorResponse(
      res,
      isAbort ? 504 : 502,
      "api_error",
      isAbort ? `upstream aborted: ${controller.signal.reason?.message ?? "unknown"}` : `upstream fetch failed: ${e.message}`,
    );
  }

  // Stream pass-through for SSE; buffered pass-through for JSON. We
  // forward the upstream content-type verbatim so the SDK's stream
  // parser still works.
  const contentType =
    upstream.headers.get("content-type") || "application/json";
  res.writeHead(upstream.status, { "content-type": contentType });
  if (!upstream.body) {
    clearTimeout(timeoutId);
    req.off("close", onClientClose);
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write(Buffer.from(value));
    }
  } catch (e) {
    if (e.name === "AbortError") {
      console.log("[proxy] forward stream aborted:", controller.signal.reason?.message);
    } else {
      console.error("[proxy] forward stream error:", e.message);
    }
  } finally {
    clearTimeout(timeoutId);
    req.off("close", onClientClose);
    try { reader.cancel(); } catch { /* already closed */ }
    res.end();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/messages
// ────────────────────────────────────────────────────────────────────────────

async function handleMessages(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return errorResponse(res, 400, "invalid_request_error", `body parse failed: ${e.message}`);
  }
  const msgContent0 = typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : JSON.stringify(body.messages?.[0]?.content ?? "");
  console.log("[proxy] /v1/messages model=%s stream=%s messages=%d system_len=%d msg0_len=%d tools=%d msg0_preview=%s", body.model, body.stream, body.messages?.length, (body.system ?? "").length, msgContent0.length, (body.tools ?? []).length, msgContent0.slice(0, 80));
  if (body.tools?.length) console.log("[proxy] first_tool:", body.tools[0]?.name, "schema_len:", JSON.stringify(body.tools[0]?.input_schema ?? {}).length);
  try { fs.writeFileSync("/tmp/last_request.json", JSON.stringify(body, null, 2)); } catch { /* ignore */ }
  const validation = validateMessagesBody(body);
  if (!validation.ok) {
    return errorResponse(res, 400, "invalid_request_error", validation.error);
  }

  let ctx;
  try {
    ctx = await resolver.resolve(req);
  } catch (e) {
    console.error("[proxy] resolver.resolve threw:", e);
    return errorResponse(res, 500, "api_error", `resolver failure: ${e?.message ?? "unknown error"}`);
  }
  if (ctx.error) {
    return errorResponse(res, ctx.error.status, ctx.error.type, ctx.error.message);
  }

  if (ctx.mode === "api_key") {
    if (ctx.provider !== "anthropic") {
      return errorResponse(
        res,
        400,
        "invalid_request_error",
        `proxy forwarding is only implemented for Anthropic api_key credentials (got '${ctx.provider}')`,
      );
    }
    return forwardAnthropicMessages(req, res, body, ctx);
  }

  const { promptText } = anthropicMessagesToPrompt(body);
  // Always use non-streaming internally: --output-format stream-json requires
  // --verbose which creates ~35K cache tokens per call (charged as "extra
  // usage" on subscription). Non-streaming reads from the warm cache instead.
  //
  // System prompt is embedded in promptText (not passed via --append-system-prompt)
  // to avoid cache-creation "extra usage" tokens — see anthropicMessagesToPrompt.
  const cliArgs = buildClaudeArgs({ model: body.model, systemPrompt: null, streaming: false });
  console.log("[proxy] prompt_len=%d stream_requested=%s home=%s", promptText.length, body.stream, ctx.home);

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(ctx.home),
  });
  proc.on("close", () => { postSpawnCleanup(ctx).catch((e) => console.error("[proxy] postSpawnCleanup failed:", e.message)); });

  if (body.stream === true) {
    return bufferedThenSSE(proc, res, body.model);
  }
  return bufferedResponse(proc, res, body.model);
}

// ────────────────────────────────────────────────────────────────────────────
// POST /v1/chat/completions  (OpenAI-compatible alias)
// ────────────────────────────────────────────────────────────────────────────

async function handleChatCompletions(req, res) {
  let rawBody;
  try {
    rawBody = await readJsonBody(req);
  } catch (e) {
    return errorResponse(res, 400, "invalid_request_error", `body parse failed: ${e.message}`);
  }

  const body = openAIBodyToAnthropic(rawBody);
  const validation = validateMessagesBody(body);
  if (!validation.ok) {
    return errorResponse(res, 400, "invalid_request_error", validation.error);
  }

  let ctx;
  try {
    ctx = await resolver.resolve(req);
  } catch (e) {
    console.error("[proxy] resolver.resolve threw:", e);
    return errorResponse(res, 500, "api_error", `resolver failure: ${e?.message ?? "unknown error"}`);
  }
  if (ctx.error) {
    return errorResponse(res, ctx.error.status, ctx.error.type, ctx.error.message);
  }

  if (ctx.mode === "api_key") {
    return errorResponse(
      res,
      400,
      "invalid_request_error",
      "OpenAI-shape forwarding for api_key credentials is not implemented yet - use /v1/messages with an Anthropic credential",
    );
  }

  const { promptText, systemText } = anthropicMessagesToPrompt(body);
  const cliArgs = buildClaudeArgs({ model: body.model, systemPrompt: systemText, streaming: body.stream === true });

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(ctx.home),
  });
  proc.on("close", () => { postSpawnCleanup(ctx).catch((e) => console.error("[proxy] postSpawnCleanup failed:", e.message)); });

  if (body.stream === true) {
    return streamResponseOpenAI(proc, res, body.model);
  }

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => { stdout += c.toString(); });
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  proc.on("error", (e) => errorResponse(res, 500, "api_error", `claude spawn failed: ${e.message}`));
  proc.on("close", (code) => {
    if (code !== 0) {
      return errorResponse(res, 502, "api_error", `claude exit ${code}: ${stderr.trim() || "no stderr"}`);
    }
    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch (e) { return errorResponse(res, 502, "api_error", `failed to parse claude output: ${e.message}`); }
    const anthropicResp = claudeJsonToAnthropic(parsed, body.model);
    const openAIResp = anthropicToOpenAIResponse(anthropicResp);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(openAIResp));
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Response handling
// ────────────────────────────────────────────────────────────────────────────

function bufferedResponse(proc, res, model) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => { stdout += c.toString(); });
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  proc.on("error", (e) => errorResponse(res, 500, "api_error", `claude spawn failed: ${e.message}`));
  proc.on("close", (code) => {
    console.log("[proxy] claude exit=%d stdout_len=%d stderr=%s", code, stdout.length, stderr.slice(0, 200));
    if (code !== 0) {
      return errorResponse(res, 502, "api_error", `claude exit ${code}: ${stderr.trim() || stdout.slice(0,200) || "no output"}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      return errorResponse(res, 502, "api_error", `failed to parse claude json output: ${e.message}`);
    }
    const anthropicResponse = claudeJsonToAnthropic(parsed, model);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(anthropicResponse));
  });
}

/**
 * Call claude non-streaming, then emit the result as Anthropic SSE events so
 * the Anthropic Python SDK on the other end sees a valid streaming response.
 * This avoids --verbose / stream-json which creates ~35K cache tokens per call.
 */
function bufferedThenSSE(proc, res, model) {
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (c) => { stdout += c.toString(); });
  proc.stderr.on("data", (c) => { stderr += c.toString(); });
  proc.on("error", (e) => errorResponse(res, 500, "api_error", `claude spawn failed: ${e.message}`));
  proc.on("close", (code) => {
    console.log("[proxy] bufferedThenSSE claude exit=%d stderr=%s", code, stderr.slice(0, 200));
    if (code !== 0) {
      let detail = stderr.trim();
      try { const j = JSON.parse(stdout); if (j?.is_error && j?.result) detail = j.result; } catch { /* ignore */ }
      errorResponse(res, 502, "api_error", detail || `claude exit ${code}`);
      return;
    }
    let parsed;
    try { parsed = JSON.parse(stdout); }
    catch (e) { errorResponse(res, 502, "api_error", `failed to parse claude output: ${e.message}`); return; }
    const anthropicResp = claudeJsonToAnthropic(parsed, model);
    const text = anthropicResp.content?.[0]?.text ?? "";
    const u = anthropicResp.usage ?? {};

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" });
    sendSSE(res, "message_start", {
      type: "message_start",
      message: { id: anthropicResp.id, type: "message", role: "assistant", model: anthropicResp.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: u.input_tokens, output_tokens: 1 } },
    });
    sendSSE(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    sendSSE(res, "ping", { type: "ping" });
    sendSSE(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    sendSSE(res, "content_block_stop", { type: "content_block_stop", index: 0 });
    sendSSE(res, "message_delta", { type: "message_delta", delta: { stop_reason: anthropicResp.stop_reason ?? "end_turn", stop_sequence: null }, usage: { output_tokens: u.output_tokens } });
    sendSSE(res, "message_stop", { type: "message_stop" });
    res.end();
  });
}

function streamResponse(proc, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  let buffer = "";
  let stderrBuf = "";
  let rawOut = "";
  let lastResultMsg = "";
  proc.stdout.on("data", (chunk) => {
    rawOut += chunk.toString();
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      const mapped = mapClaudeStreamEvent(evt);
      if (mapped) {
        for (const m of mapped) sendSSE(res, m.event, m.data);
      }
      // Track the result line for error reporting when claude exits non-zero
      if (evt?.type === "result" && typeof evt.result === "string" && evt.is_error) {
        lastResultMsg = evt.result;
      }
    }
  });
  proc.stderr.on("data", (c) => { stderrBuf += c.toString(); });
  proc.on("error", () => {
    sendSSE(res, "error", { type: "error", error: { type: "api_error", message: "claude spawn failed" } });
    res.end();
  });
  proc.on("close", (code) => {
    console.log("[proxy] stream claude exit=%d stderr=%s", code, stderrBuf.slice(0, 200));
    if (code !== 0) {
      const detail = lastResultMsg || stderrBuf.trim() || `claude exit ${code}`;
      console.log("[proxy] stream error detail:", detail.slice(0, 200));
      sendSSE(res, "error", {
        type: "error",
        error: { type: "api_error", message: detail },
      });
    }
    // On clean exit claude already emitted message_stop — no need to add one.
    res.end();
  });
}

function streamResponseOpenAI(proc, res, model) {
  const chatId = `chatcmpl-${randomBytes(12).toString("hex")}`;
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  const sendChunk = (content) => {
    const chunk = {
      id: chatId, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  let buffer = "";
  let stderrBuf = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt?.type === "stream_event" && evt.event?.type === "content_block_delta") {
        const text = evt.event?.delta?.text;
        if (text) sendChunk(text);
      }
    }
  });
  proc.stderr.on("data", (c) => { stderrBuf += c.toString(); });
  proc.on("error", () => { res.write("data: [DONE]\n\n"); res.end(); });
  proc.on("close", () => { res.write("data: [DONE]\n\n"); res.end(); });
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk.toString(); });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function errorResponse(res, status, type, message) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}
