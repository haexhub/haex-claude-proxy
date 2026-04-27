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
 * Auth: inbound `x-api-key` / `Authorization` headers are ignored. The proxy
 * relies on OAuth tokens in `~/.claude/.credentials.json` mounted into the
 * container. Anyone who can reach the port can use the proxy — keep it on an
 * internal network.
 *
 * Streaming: when the request has `stream: true`, the proxy spawns claude
 * with `--output-format stream-json --include-partial-messages` and pipes the
 * native Anthropic SSE events claude emits straight back to the caller.
 */
import http from "node:http";
import { spawn } from "node:child_process";

import {
  validateMessagesBody,
  anthropicMessagesToPrompt,
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
} from "./cli-format.js";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

// When this process is itself running inside a Claude Code session (developer
// laptops), `CLAUDECODE=1` is set and the spawned `claude` CLI refuses with
// "Claude Code cannot be launched inside another Claude Code session". We
// always strip these from the child env — production Docker has neither set.
const SUBPROCESS_ENV = (() => {
  const e = { ...process.env };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  return e;
})();

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
  const proc = spawn(CLAUDE_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"], env: SUBPROCESS_ENV });
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
  const validation = validateMessagesBody(body);
  if (!validation.ok) {
    return errorResponse(res, 400, "invalid_request_error", validation.error);
  }

  const { promptText, systemText } = anthropicMessagesToPrompt(body);
  const cliArgs = buildClaudeArgs({
    model: body.model,
    systemPrompt: systemText,
    streaming: body.stream === true,
  });

  const proc = spawn(CLAUDE_BIN, [...cliArgs, "--print", promptText], {
    stdio: ["ignore", "pipe", "pipe"],
    env: SUBPROCESS_ENV,
  });

  if (body.stream === true) {
    return streamResponse(proc, res);
  }
  return bufferedResponse(proc, res, body.model);
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
    if (code !== 0) {
      return errorResponse(res, 502, "api_error", `claude exit ${code}: ${stderr.trim() || "no stderr"}`);
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

function streamResponse(proc, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  // claude (with --include-partial-messages) emits its own message_start /
  // content_block_* / message_stop events wrapped as {type:"stream_event"}.
  // We unwrap and pass through — synthesizing our own message_start would
  // produce duplicate events at the SDK consumer.
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
      const mapped = mapClaudeStreamEvent(evt);
      if (mapped) {
        for (const m of mapped) sendSSE(res, m.event, m.data);
      }
    }
  });
  proc.stderr.on("data", (c) => { stderrBuf += c.toString(); });
  proc.on("error", () => {
    sendSSE(res, "error", { type: "error", error: { type: "api_error", message: "claude spawn failed" } });
    res.end();
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      sendSSE(res, "error", {
        type: "error",
        error: { type: "api_error", message: `claude exit ${code}: ${stderrBuf.trim()}` },
      });
    }
    // On clean exit claude already emitted message_stop — no need to add one.
    res.end();
  });
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
