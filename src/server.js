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
 *   GET  /healthz       Liveness check + a synthetic `claude --version`.
 *
 * Auth (multi-tenant only — no host fallback):
 *   - The proxy requires DATABASE_URL pointed at specifyr's DB.
 *     Without it every request returns 503.
 *   - Each request MUST carry a 64-hex-char session token (minted by
 *     specifyr's runner_sessions table) via `x-api-key` or
 *     `Authorization: Bearer …`. Tokens that don't resolve → 401.
 *   - Resolved tokens spawn `claude` with
 *     HOME=/credentials/<ownerKind>/<ownerId>; that dir is bind-
 *     mounted RW so the CLI can refresh tokens in place.
 *   - There is intentionally NO host `~/.claude` fallback: every
 *     user's OAuth login lands in their own dir inside this
 *     container, isolated from each other and from the host.
 *
 * Streaming: when the request has `stream: true`, the proxy spawns claude
 * with `--output-format stream-json --include-partial-messages` and pipes the
 * native Anthropic SSE events claude emits straight back to the caller.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";

import pg from "pg";

import {
  validateMessagesBody,
  anthropicMessagesToPrompt,
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
  openAIBodyToAnthropic,
  anthropicToOpenAIResponse,
} from "./cli-format.js";
import {
  createDbLookup,
  extractSessionToken,
  homeForOwner,
  looksLikeSessionToken,
} from "./auth.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// Where the per-owner `.claude/.credentials.json` files live
// (bind-mounted from the host by ansible). The proxy is multi-tenant
// only — every authenticated request lands in a subdir under here.
const CREDENTIALS_ROOT = process.env.CREDENTIALS_ROOT ?? "/credentials";

// Lazy pg pool. DATABASE_URL is required — the proxy refuses to
// resolve any inbound request without a working session-token lookup.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const pool = DATABASE_URL
  ? new pg.Pool({ connectionString: DATABASE_URL, max: 5 })
  : null;
const lookupSession = pool ? createDbLookup(pool) : async () => null;

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
 * Resolves the HOME directory for a single inbound request. Returns
 * either a string (HOME) or an `{ error }` shape that the handler
 * forwards as an HTTP error. Multi-tenant by design: there is NO
 * host-credentials fallback. Every request must arrive with a
 * session token that resolves against the runner_sessions table.
 */
async function resolveRequestHome(req) {
  if (!pool) {
    return {
      error: {
        status: 503,
        type: "configuration_error",
        message:
          "DATABASE_URL is unset — proxy cannot resolve session tokens",
      },
    };
  }
  const token = extractSessionToken(req);
  if (!token || !looksLikeSessionToken(token)) {
    return {
      error: {
        status: 401,
        type: "authentication_error",
        message:
          "missing or malformed session token — agents must inject ANTHROPIC_API_KEY=<runner-session>",
      },
    };
  }
  const session = await lookupSession(token);
  if (!session) {
    return {
      error: {
        status: 401,
        type: "authentication_error",
        message:
          "session token not recognised — unknown, expired, or revoked",
      },
    };
  }
  try {
    return homeForOwner(CREDENTIALS_ROOT, session.ownerKind, session.ownerId);
  } catch (e) {
    return {
      error: {
        status: 500,
        type: "api_error",
        message: `credentials path resolution failed: ${e.message}`,
      },
    };
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

  if (req.method === "GET" && req.url === "/healthz") {
    return handleHealthz(res);
  }
  if (req.method === "POST" && req.url === "/v1/messages") {
    return handleMessages(req, res);
  }
  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/chat/completions")) {
    return handleChatCompletions(req, res);
  }

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

  const homeOrErr = await resolveRequestHome(req);
  if (typeof homeOrErr !== "string") {
    return errorResponse(res, homeOrErr.error.status, homeOrErr.error.type, homeOrErr.error.message);
  }

  const { promptText } = anthropicMessagesToPrompt(body);
  // Always use non-streaming internally: --output-format stream-json requires
  // --verbose which creates ~35K cache tokens per call (charged as "extra
  // usage" on subscription). Non-streaming reads from the warm cache instead.
  //
  // System prompt is embedded in promptText (not passed via --append-system-prompt)
  // to avoid cache-creation "extra usage" tokens — see anthropicMessagesToPrompt.
  const cliArgs = buildClaudeArgs({ model: body.model, systemPrompt: null, streaming: false });
  console.log("[proxy] prompt_len=%d stream_requested=%s home=%s", promptText.length, body.stream, homeOrErr);

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(homeOrErr),
  });

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

  const homeOrErr = await resolveRequestHome(req);
  if (typeof homeOrErr !== "string") {
    return errorResponse(res, homeOrErr.error.status, homeOrErr.error.type, homeOrErr.error.message);
  }

  const { promptText, systemText } = anthropicMessagesToPrompt(body);
  const cliArgs = buildClaudeArgs({ model: body.model, systemPrompt: systemText, streaming: body.stream === true });

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(homeOrErr),
  });

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
