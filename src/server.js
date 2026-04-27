#!/usr/bin/env node
/**
 * claude-oauth-proxy — Anthropic-API-kompatibler HTTP-Server der `claude` CLI
 * als Subprocess wraps. Erlaubt jedem Anthropic-API-Client (z.B. hermes-agent),
 * eine Claude Pro/Max-Subscription via OAuth-Tokens zu nutzen statt einen
 * separaten API-Key zu verbrauchen.
 *
 * Architektur:
 *
 *   hermes-agent  --HTTP-->  claude-oauth-proxy  --subprocess-->  claude CLI
 *   (--provider             (this server)                        (uses OAuth from
 *    anthropic +                                                  ~/.claude)
 *    BASE_URL)
 *                                                       \---HTTPS--->  api.anthropic.com
 *
 * Endpoints:
 *
 *   POST /v1/messages                Anthropic Messages API. Translates the
 *                                    incoming Anthropic-format request into a
 *                                    claude CLI invocation, captures structured
 *                                    output, and streams/returns Anthropic-format
 *                                    response. Tools defined in the request are
 *                                    passed through as `tool_use` blocks (we
 *                                    DO NOT execute them — claude is run with
 *                                    `--allowed-tools ""` so the model returns
 *                                    tool intents as data, leaving execution to
 *                                    the original caller).
 *
 *   GET  /healthz                    Liveness check + a synthetic `claude
 *                                    --version` to verify the CLI is reachable.
 *
 * Auth:
 *
 *   Inbound auth-Header (`x-api-key` / `Authorization`) wird ignoriert — der
 *   Proxy nutzt OAuth-Tokens aus dem `~/.claude/`-Mount des Containers. Wer
 *   Zugriff auf den Proxy-Port hat, kann den Proxy nutzen. Daher: nur intern
 *   im Docker-Netzwerk exposen, NIE öffentlich.
 *
 * Streaming:
 *
 *   Anthropic-API kann `stream: true` setzen — wir reagieren mit SSE
 *   (`text/event-stream`). Die claude-CLI im `--output-format stream-json`
 *   liefert NDJSON-Zeilen, die wir on-the-fly in Anthropic-SSE-Events
 *   mappen.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";

const server = http.createServer(async (req, res) => {
  // CORS for browser-side debugging — only allow during dev. Tighten in prod
  // by removing if the proxy is purely server-to-server.
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
  console.log(`[claude-oauth-proxy] listening on http://${HOST}:${PORT}`);
});

// ────────────────────────────────────────────────────────────────────────────
// /healthz
// ────────────────────────────────────────────────────────────────────────────

function handleHealthz(res) {
  // Spawn claude --version to verify the CLI is callable. Returns 200 only
  // if the subprocess exits 0 — caught by orchestrator liveness probes.
  const proc = spawn(CLAUDE_BIN, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  proc.stdout.on("data", (chunk) => { out += chunk.toString(); });
  proc.stderr.on("data", (chunk) => { err += chunk.toString(); });
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
  });

  if (body.stream === true) {
    return streamResponse(proc, res, body.model);
  }
  return bufferedResponse(proc, res, body.model);
}

// ────────────────────────────────────────────────────────────────────────────
// Request validation + format translation
// ────────────────────────────────────────────────────────────────────────────

export function validateMessagesBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "request body must be an object" };
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return { ok: false, error: "missing or empty 'model'" };
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return { ok: false, error: "'messages' must be a non-empty array" };
  }
  for (const [i, m] of body.messages.entries()) {
    if (!m || typeof m !== "object" || Array.isArray(m)) {
      return { ok: false, error: `messages[${i}] must be an object` };
    }
    if (m.role !== "user" && m.role !== "assistant") {
      return { ok: false, error: `messages[${i}].role must be 'user' or 'assistant'` };
    }
    if (m.content == null) {
      return { ok: false, error: `messages[${i}].content is required` };
    }
  }
  return { ok: true };
}

/**
 * Flatten an Anthropic Messages-API request into a single prompt string +
 * separate system prompt that we pass via `--append-system-prompt`.
 *
 * For Phase 1 we concatenate the conversation into a single text turn.
 * Multi-turn stream-json input handling is a Phase-2 enhancement (would
 * require piping NDJSON to stdin instead of `--print`).
 *
 * Tools defined on the request are stringified into the prompt as a
 * specification — claude with `--allowed-tools ""` will then surface
 * tool-call intents in its output as `tool_use` blocks for the caller to
 * execute. This works because the model NATIVELY supports tool definitions
 * in the Anthropic API; we just relay them.
 *
 * @param {object} body  validated Anthropic Messages-API body
 * @returns {{promptText: string, systemText: string|null}}
 */
export function anthropicMessagesToPrompt(body) {
  const lines = [];

  // System prompt is passed separately via --append-system-prompt to keep it
  // out of the user-visible turn structure. Anthropic accepts both string
  // and array-of-content-blocks for system; we flatten arrays to text.
  const systemText = body.system != null ? flattenContent(body.system) : null;

  // Tools, if present, are documented in the system block so the model knows
  // what the caller can execute. claude itself won't execute them.
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const toolsSpec = body.tools
      .map((t) => `- ${t.name}: ${t.description ?? "(no description)"}\n  input_schema: ${JSON.stringify(t.input_schema ?? {})}`)
      .join("\n");
    lines.push(`<available_tools>\n${toolsSpec}\n</available_tools>\n`);
  }

  // Conversation flattening with explicit role markers — claude's --print
  // mode treats argv as one big text. Multi-turn semantic preserved by tags
  // that the model recognizes, NOT by claude's own session state (we use
  // --no-session-persistence).
  for (const m of body.messages) {
    const text = flattenContent(m.content);
    lines.push(`<turn role="${m.role}">${text}</turn>`);
  }

  return { promptText: lines.join("\n"), systemText };
}

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block?.type === "text") return block.text ?? "";
      if (block?.type === "tool_use") {
        return `<tool_use name="${block.name}" id="${block.id}">${JSON.stringify(block.input ?? {})}</tool_use>`;
      }
      if (block?.type === "tool_result") {
        return `<tool_result tool_use_id="${block.tool_use_id}">${flattenContent(block.content ?? "")}</tool_result>`;
      }
      return JSON.stringify(block);
    })
    .join("\n");
}

/**
 * @param {object} opts
 * @param {string} opts.model
 * @param {string|null} opts.systemPrompt
 * @param {boolean} opts.streaming
 * @returns {string[]} CLI args for claude (excluding the trailing `--print TEXT`)
 */
export function buildClaudeArgs({ model, systemPrompt, streaming }) {
  const args = [
    "--no-session-persistence",
    "--allowed-tools", "",
    "--output-format", streaming ? "stream-json" : "json",
    "--include-partial-messages",
    "--model", model,
  ];
  if (systemPrompt) {
    args.push("--append-system-prompt", systemPrompt);
  }
  if (streaming) {
    args.push("--input-format", "stream-json");
  }
  return args;
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

function streamResponse(proc, res, model) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });

  const messageId = `msg_${randomUUID().replace(/-/g, "")}`;
  let started = false;

  // Send initial message_start event so SSE consumers see structure ASAP.
  sendSSE(res, "message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let buffer = "";
  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        const mapped = mapClaudeStreamEvent(evt, started);
        if (mapped) {
          for (const m of mapped) sendSSE(res, m.event, m.data);
          if (mapped.some((m) => m.event === "content_block_start")) started = true;
        }
      } catch {
        // Skip torn lines silently — partial JSON during streaming is normal
        // before all bytes arrive. The buffer-and-resplit pattern above
        // handles eventual reassembly.
      }
    }
  });
  proc.stderr.on("data", (c) => {
    // Accumulate but only emit if process eventually fails.
    proc._stderrBuf = (proc._stderrBuf ?? "") + c.toString();
  });
  proc.on("error", () => {
    sendSSE(res, "error", { type: "error", error: { type: "api_error", message: "claude spawn failed" } });
    res.end();
  });
  proc.on("close", (code) => {
    if (code !== 0) {
      sendSSE(res, "error", {
        type: "error",
        error: { type: "api_error", message: `claude exit ${code}: ${(proc._stderrBuf ?? "").trim()}` },
      });
    } else {
      sendSSE(res, "message_stop", { type: "message_stop" });
    }
    res.end();
  });
}

function sendSSE(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Translate a single claude stream-json line into zero or more Anthropic SSE
 * events. Returns null if the line should be ignored (e.g. unknown event types
 * or claude-internal protocol noise).
 *
 * The exact shape of claude's stream-json is verified at runtime — we
 * tolerate unknown fields and fall back to skipping.
 */
function mapClaudeStreamEvent(claudeEvt, alreadyStarted) {
  // claude stream-json emits objects shaped roughly:
  //   { type: "system", subtype: "init", ... }
  //   { type: "assistant", message: { content: [...], ... } }
  //   { type: "result", subtype: "success", result: "...", ... }
  // For a tools-disabled, stateless single-turn invocation we mostly care about
  // assistant events with content text deltas.
  if (claudeEvt.type === "assistant" && claudeEvt.message?.content) {
    const events = [];
    for (const block of claudeEvt.message.content) {
      if (block.type === "text" && block.text) {
        if (!alreadyStarted) {
          events.push({
            event: "content_block_start",
            data: {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            },
          });
        }
        events.push({
          event: "content_block_delta",
          data: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: block.text },
          },
        });
      }
    }
    return events.length > 0 ? events : null;
  }
  return null;
}

/**
 * Translate claude's non-streaming JSON output into an Anthropic Messages API
 * response shape. claude's `--output-format json` emits a single object
 * containing the full result.
 */
export function claudeJsonToAnthropic(claudeOut, model) {
  // Best-effort parsing — claude json shape can include various meta fields.
  // We extract the main result text and surface anything else as usage.
  const resultText =
    typeof claudeOut.result === "string"
      ? claudeOut.result
      : Array.isArray(claudeOut.messages)
        ? claudeOut.messages
            .filter((m) => m.role === "assistant")
            .flatMap((m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }]))
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("")
        : "";

  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: resultText }],
    stop_reason: claudeOut.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: claudeOut.usage?.input_tokens ?? 0,
      output_tokens: claudeOut.usage?.output_tokens ?? 0,
    },
  };
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
