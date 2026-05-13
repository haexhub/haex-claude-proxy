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
 * Auth (multi-tenant only — no host fallback):
 *   - DATABASE_URL pointed at specifyr's Postgres is required. Without
 *     it every request returns 503.
 *   - SPECIFYR_SECRET_KEY (64 hex chars) must match specifyr's master
 *     key — the proxy decrypts oauth credentials with it on every
 *     request.
 *   - Each request MUST carry a 64-hex-char session token (minted by
 *     specifyr's runner_sessions table) via `x-api-key` or
 *     `Authorization: Bearer …`. Tokens that don't resolve → 401.
 *   - The resolver pulls the encrypted oauth blob from the
 *     `llm_credentials` table (RLS-aware: SET LOCAL app.current_owner_*),
 *     decrypts it in-process, and stages a per-request ephemeral HOME
 *     under CREDENTIALS_ROOT (default /run/credentials) — typically a
 *     tmpfs in production. The spawned `claude` CLI reads
 *     `$HOME/.claude/.credentials.json` from there. After exit we
 *     read the file back; if the CLI refreshed the token, we encrypt
 *     and write it to the DB, then remove the staging dir.
 *   - No bind-mounted credentials dir, no host `~/.claude` fallback,
 *     no plaintext credential on disk past process exit.
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
  createCredentialsStore,
  createDbLookup,
  extractSessionToken,
  looksLikeSessionToken,
  parseExpiresAt,
} from "./auth.js";
import { decrypt, encrypt } from "./crypto.js";

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

// Wurzel für ephemere Per-Request-HOMEs. tmpfs-Mount (`/run/credentials`,
// uid=1000, mode=0700, in-memory) wird vom ansible-compose bereitgestellt.
// Pro Request: <root>/<spawn-id>/.claude/.credentials.json — gelöscht
// nach Subprozess-Exit. KEIN Host-Bind, keine Persistenz.
const CREDENTIALS_ROOT = process.env.CREDENTIALS_ROOT ?? "/run/credentials";

// Lazy pg pool. DATABASE_URL is required — the proxy refuses to
// resolve any inbound request without a working session-token lookup.
const DATABASE_URL = process.env.DATABASE_URL ?? "";
const pool = DATABASE_URL
  ? new pg.Pool({ connectionString: DATABASE_URL, max: 5 })
  : null;
const lookupSession = pool ? createDbLookup(pool) : async () => null;
const credentialsStore = pool ? createCredentialsStore(pool, decrypt) : null;

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
 * Bereitet eine per-Request HOME vor:
 *   1. Session-Token resolven → (ownerKind, ownerId).
 *   2. Verschlüsselte oauth_claude credentials aus DB lesen, decrypted.
 *   3. Ephemeren tmpfs-Pfad anlegen, `.claude/.credentials.json` schreiben.
 *   4. Return-Wert trägt den Pfad UND alles was wir für Writeback nach
 *      Spawn-Exit brauchen (credId, owner, spawnDir).
 *
 * Auf Fehler: `{ error: { status, type, message } }` — Handler reicht
 * das als HTTP-Error weiter.
 */
async function resolveRequestHome(req) {
  if (!pool || !credentialsStore) {
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
  let cred;
  try {
    cred = await credentialsStore.load(session.ownerKind, session.ownerId);
  } catch (e) {
    return {
      error: {
        status: 500,
        type: "api_error",
        message: `credentials lookup failed: ${e.message}`,
      },
    };
  }
  if (!cred) {
    return {
      error: {
        status: 401,
        type: "authentication_error",
        message:
          "no authorised Anthropic OAuth credential for this owner — re-run the in-app OAuth flow",
      },
    };
  }
  // Ephemerer Spawn-Pfad: /run/credentials/<random>/.claude/.credentials.json
  const spawnId = randomBytes(12).toString("hex");
  const home = path.join(CREDENTIALS_ROOT, spawnId);
  try {
    await fsp.mkdir(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
    await fsp.writeFile(
      path.join(home, ".claude", ".credentials.json"),
      cred.plaintext,
      { mode: 0o600 },
    );
  } catch (e) {
    return {
      error: {
        status: 500,
        type: "api_error",
        message: `failed to stage credentials: ${e.message}`,
      },
    };
  }
  return {
    home,
    credId: cred.id,
    ownerKind: session.ownerKind,
    ownerId: session.ownerId,
  };
}

/**
 * Nach Subprozess-Exit aufgerufen: liest `.credentials.json` nochmal —
 * falls die Claude-CLI während des Calls den Access-Token refresht hat,
 * landet der refreshte Blob hier. Schreibt verschlüsselt zurück in DB.
 *
 * Anschließend räumt cleanup() den tmpfs-Pfad weg. Beide Schritte sind
 * idempotent / no-throw — der Plaintext-Token verschwindet auf jeden
 * Fall aus dem RAM-FS, auch wenn DB-Writeback fehlschlägt (worst case:
 * der bisherige DB-Token bleibt unverändert, beim nächsten Spawn macht
 * claude erneut einen Refresh).
 */
async function persistRefreshedTokenAndCleanup(ctx) {
  if (!credentialsStore) return; // belt-and-braces — sollten wir nie erreichen
  const credPath = path.join(ctx.home, ".claude", ".credentials.json");
  try {
    const refreshed = await fsp.readFile(credPath, "utf8");
    if (refreshed && refreshed !== ctx.originalPlaintext) {
      const expiresAt = parseExpiresAt(refreshed);
      const encrypted = encrypt(refreshed);
      await credentialsStore
        .writeback(ctx.credId, ctx.ownerKind, ctx.ownerId, encrypted, expiresAt)
        .catch((e) => console.error("[proxy] writeback failed:", e.message));
    }
  } catch (e) {
    if (e.code !== "ENOENT") {
      console.error("[proxy] refresh-readback failed:", e.message);
    }
  } finally {
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
// session-token resolution. This also keeps the model probe usable in
// configurations that don't have DATABASE_URL wired up (e.g. local dev
// with a single-user OAuth dir mounted directly at /credentials/...).
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

  const ctx = await resolveRequestHome(req);
  if (ctx.error) {
    return errorResponse(res, ctx.error.status, ctx.error.type, ctx.error.message);
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

  // Originalen Plaintext mitschleifen, damit persistRefreshedTokenAndCleanup
  // den DB-Write nur dann ausführt, wenn die Datei nach Spawn tatsächlich
  // verändert wurde (Refresh-Detection per Inhalts-Vergleich).
  try {
    ctx.originalPlaintext = await fsp.readFile(
      path.join(ctx.home, ".claude", ".credentials.json"),
      "utf8",
    );
  } catch { ctx.originalPlaintext = ""; }

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(ctx.home),
  });
  proc.on("close", () => { persistRefreshedTokenAndCleanup(ctx); });

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

  const ctx = await resolveRequestHome(req);
  if (ctx.error) {
    return errorResponse(res, ctx.error.status, ctx.error.type, ctx.error.message);
  }

  const { promptText, systemText } = anthropicMessagesToPrompt(body);
  const cliArgs = buildClaudeArgs({ model: body.model, systemPrompt: systemText, streaming: body.stream === true });

  try {
    ctx.originalPlaintext = await fsp.readFile(
      path.join(ctx.home, ".claude", ".credentials.json"),
      "utf8",
    );
  } catch { ctx.originalPlaintext = ""; }

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: envForHome(ctx.home),
  });
  proc.on("close", () => { persistRefreshedTokenAndCleanup(ctx); });

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
