/**
 * Pure helpers that translate between Anthropic Messages-API shapes and the
 * `claude` CLI's input/output formats.
 *
 * No I/O, no subprocess, no HTTP — every export is a pure function so the
 * mappings can be unit-tested without a running CLI.
 *
 * Real CLI output shapes were captured in `docs/phase-0-findings.md`; the
 * mappings below are derived from those captures, NOT from speculation.
 */

import { randomUUID } from "node:crypto";

/**
 * Validate a body submitted to POST /v1/messages. Returns `{ok:true}` or
 * `{ok:false, error}`. Mirrors the small subset of Anthropic's schema that
 * the proxy actually consumes.
 */
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
 * Flatten an Anthropic Messages-API request into a single text prompt and a
 * separate system text. The proxy passes the user-side as the trailing
 * positional arg to `claude --print`, and the system text via
 * `--append-system-prompt`.
 *
 * Phase 1 strategy: concatenate turns with `<turn role="…">…</turn>` tags.
 * Phase 2 will switch multi-turn chats to NDJSON-on-stdin so claude handles
 * the conversation state natively.
 */
export function anthropicMessagesToPrompt(body) {
  const lines = [];
  const systemText = body.system != null ? flattenContent(body.system) : null;

  // Tools are intentionally not expanded into the prompt — the claude CLI runs
  // with --allowed-tools "" so it cannot execute any tool_use blocks, and
  // including full tool schemas inflates input tokens enormously (can add 30K+
  // tokens for a typical hermes tool list). The caller handles tool execution
  // on its side; this proxy only needs to return the model's text reasoning.

  for (const m of body.messages) {
    const text = flattenContent(m.content);
    lines.push(`<turn role="${m.role}">${text}</turn>`);
  }

  return { promptText: lines.join("\n"), systemText };
}

/**
 * Like anthropicMessagesToPrompt, but WITHOUT the `<turn role="…">` wrapper —
 * used for image-bearing requests, where a message's flattened text contains
 * an `@path` mention (see server.js's materializeImageBlocks).
 *
 * Verified empirically against the real CLI: an `@path` mention embedded
 * inside `<turn role="user">…</turn>` makes the CLI treat it as quoted/untrusted
 * content and refuse to read the file, replying with a request for
 * permission instead — which `--print` can never satisfy (non-interactive).
 * The same mention in plain, unwrapped text resolves correctly as a real
 * vision attachment every time. Multi-turn role distinction isn't needed for
 * the single-shot image use case this serves, so messages are joined with a
 * blank line instead.
 */
export function anthropicMessagesToImagePrompt(body) {
  const systemText = body.system != null ? flattenContent(body.system) : null;
  const promptText = body.messages.map((m) => flattenContent(m.content)).join("\n\n");
  return { promptText, systemText };
}

/**
 * True if any message carries an `image` content block. Such requests can't go
 * through flattenContent as-is — it would `JSON.stringify` the image block
 * into the prompt, so the model receives a base64 blob as text and never sees
 * an actual image. The server materializes these blocks to temp files and
 * rewrites them to `@path` text mentions (which the CLI resolves as real
 * vision input) before building the prompt — see server.js's
 * materializeImageBlocks.
 */
export function hasImageBlocks(body) {
  return (body.messages ?? []).some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b?.type === "image"),
  );
}

// An `@path` file mention: `@` starting a whitespace-delimited token and
// immediately followed by a path-like char (`/` absolute, `~` home, `.`
// relative). Deliberately narrow so it does NOT match `user@host`,
// `@scope/pkg`, or CSS `@media` — only things the CLI would resolve as a file.
const PATH_MENTION_RE = /(^|\s)@[/~.]/;

// Deep-walk any value reachable from `body.system` / `body.messages`, testing
// every string leaf. Mirrors the reach of flattenContent — it recurses into
// tool_result.content and JSON.stringify's unknown blocks — so we can't check
// just `type:"text"` blocks at the top level. Also covers `body.system`
// (extracted the same way for image and non-image paths).
function anyStringMatches(v, re) {
  if (v == null) return false;
  if (typeof v === "string") return re.test(v);
  if (typeof v !== "object") return false;
  if (Array.isArray(v)) {
    for (const item of v) if (anyStringMatches(item, re)) return true;
    return false;
  }
  for (const key of Object.keys(v)) {
    if (anyStringMatches(v[key], re)) return true;
  }
  return false;
}

/**
 * True if any caller-supplied text carries an `@path` file mention.
 *
 * Image requests skip the `<turn role="…">` wrapper (see
 * anthropicMessagesToImagePrompt) that otherwise makes the CLI treat `@path`
 * mentions as quoted/untrusted and refuse to read them. Without that wrapper,
 * a mention anywhere the CLI ends up seeing would be resolved as a real file
 * read — arbitrary local-file disclosure into the model context (e.g.
 * `@/home/user/.claude/.credentials.json`). The proxy only ever injects its
 * own temp-file mentions; a mention in caller text is rejected upstream
 * before the prompt is built.
 *
 * Scans both `body.system` and `body.messages`, and recurses into every
 * string leaf — flattenContent inlines `tool_result.content` verbatim and
 * joins blocks with `\n`, so a mention nested inside a `tool_result` (or any
 * other block whose string content ends up in the flat prompt) is just as
 * live as one in a top-level text block. Deep walk keeps the scanner honest
 * against whatever shape the API accepts today or tomorrow.
 */
export function hasCallerPathMention(body) {
  if (anyStringMatches(body.system, PATH_MENTION_RE)) return true;
  return anyStringMatches(body.messages, PATH_MENTION_RE);
}

/**
 * Reduce a content value (string OR array of typed blocks) to a single string.
 */
export function flattenContent(content) {
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
 * pydantic-ai's (and other structured-output callers') default name for the
 * synthetic "tool" used to force a schema-conforming final answer. Function
 * tools the agent itself defines (for the model to call mid-reasoning, e.g.
 * a search tool) are NOT this — only the output tool is.
 */
const OUTPUT_TOOL_NAME = "final_result";

/**
 * Find the output-tool schema in a Messages-API request's `tools`, if any.
 * Returns `null` when the request didn't ask for structured output (no tool
 * named `final_result`) — callers should skip `--json-schema` in that case.
 *
 * Only the *output* tool is extracted here. Other tools in the same request
 * (e.g. a `search_web` function tool meant for the model to call and get a
 * result back) are still dropped — this proxy has no multi-turn tool_use ⇄
 * tool_result loop; see buildClaudeArgs's docstring.
 */
export function extractOutputToolSchema(body) {
  const tool = body?.tools?.find((t) => t?.name === OUTPUT_TOOL_NAME);
  return tool?.input_schema ?? null;
}

/**
 * Name the `claude` CLI spawns its bridged MCP server under (see
 * `buildMcpBridgeConfig`) — every bridged tool is therefore exposed to the
 * CLI as `mcp__fwbg-bridge__<name>`.
 */
export const MCP_BRIDGE_SERVER_NAME = "fwbg-bridge";

/**
 * Every request tool EXCEPT the structured-output tool (`final_result`,
 * see `extractOutputToolSchema`) — these are the caller's real function
 * tools (e.g. a search tool the model calls mid-reasoning and gets a result
 * back), the ones the MCP bridge exists to wire through.
 */
export function extractFunctionTools(body) {
  return (body?.tools ?? []).filter((t) => t?.name !== OUTPUT_TOOL_NAME);
}

/**
 * Build the `--mcp-config` JSON object (an stdio MCP server the `claude`
 * CLI spawns itself, see `src/mcp-bridge/bridge-server.js`) plus the
 * derived `--allowed-tools` allow-list for a request's bridgeable function
 * tools.
 *
 * Anthropic's `input_schema` and MCP's `inputSchema` are both plain JSON
 * Schema — direct pass-through, no translation needed. The bridge script
 * itself never sees the callback URL/token on argv (only via env on the
 * child process it's spawned as), so a `ps auxww` on the host never
 * reveals them.
 *
 * @param {{tools: object[], callbackUrl: string, callbackToken: string, timeoutMs: number, bridgeScriptPath: string}} opts
 * @returns {{config: object, allowedToolNames: string[]}}
 */
export function buildMcpBridgeConfig({ tools, callbackUrl, callbackToken, timeoutMs, bridgeScriptPath }) {
  const mcpTools = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.input_schema ?? {},
  }));
  const allowedToolNames = tools.map((t) => `mcp__${MCP_BRIDGE_SERVER_NAME}__${t.name}`);
  return {
    config: {
      mcpServers: {
        [MCP_BRIDGE_SERVER_NAME]: {
          command: "node",
          args: [bridgeScriptPath],
          env: {
            MCP_BRIDGE_TOOLS: JSON.stringify(mcpTools),
            MCP_BRIDGE_CALLBACK_URL: callbackUrl,
            MCP_BRIDGE_CALLBACK_TOKEN: callbackToken,
            MCP_BRIDGE_TOOL_TIMEOUT_MS: String(timeoutMs),
          },
        },
      },
    },
    allowedToolNames,
  };
}

/**
 * Read the `x-tool-callback-url` / `x-tool-callback-token` headers a caller
 * sends when it wants its own function tools bridged through this request
 * (see `buildMcpBridgeConfig`). Returns `null` when neither header is
 * present (caller didn't ask for tool bridging — today's exact behavior).
 * Returns `{error}` when a callback was requested but the URL's host isn't
 * in `allowedHosts` — mirrors `resolveForwardTarget`'s allowlist pattern,
 * except plain `http://` is accepted (the callback target is normally an
 * intra-docker-network service, not the public internet).
 *
 * @param {Record<string, string|string[]|undefined>} headers
 * @param {Set<string>} allowedHosts
 * @returns {{url: string, token: string}|{error: string}|null}
 */
export function extractToolCallback(headers, allowedHosts) {
  const rawUrl = headers?.["x-tool-callback-url"];
  const rawToken = headers?.["x-tool-callback-token"];
  if (!rawUrl && !rawToken) return null;
  const url = Array.isArray(rawUrl) ? rawUrl[0] : rawUrl;
  const token = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (!url || !token) {
    return { error: "both x-tool-callback-url and x-tool-callback-token are required together" };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `invalid x-tool-callback-url: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: `x-tool-callback-url must be http(s), got ${parsed.protocol}` };
  }
  const host = parsed.hostname.toLowerCase();
  if (!allowedHosts.has(host)) {
    return {
      error: `host '${host}' is not in PROXY_ALLOWED_CALLBACK_HOSTS - refusing to bridge tools`,
    };
  }
  return { url, token };
}

/**
 * Build the argv (excluding the trailing `--print PROMPT`) for spawning the
 * `claude` subprocess.
 *
 * Function tools (the agent's own, e.g. a search tool the model can call
 * mid-reasoning and get a result back) are intentionally disabled via
 * `--allowed-tools ""` — that needs a real multi-turn tool_use ⇄ tool_result
 * loop this single-shot `--print` wrapper doesn't implement by default. The
 * model surfaces such tool intents as plain content blocks but nothing
 * executes them.
 *
 * When the caller passes `mcpConfigPath` + a non-empty `allowedToolNames`
 * (see `buildMcpBridgeConfig` / `extractToolCallback`), that changes: the
 * CLI is handed a real stdio MCP server via `--mcp-config` and pre-approved
 * to call it via `--allowed-tools` — its own internal agent loop can then
 * call those tools mid-task and get a real result back, all within this one
 * `--print` invocation. `--strict-mcp-config` limits it to exactly this
 * ephemeral server (no other MCP config on the host leaks in).
 *
 * NOTE (open risk, see plan "Open risks" #3): the exact `--allowed-tools`
 * syntax for multiple `mcp__fwbg-bridge__*` entries (comma-separated single
 * arg vs. repeated flag) is asserted here as comma-separated based on
 * documented CLI usage; it is NOT yet verified against a real spawn — that
 * verification is the Stage 2 E2E test in test/integration.test.js.
 *
 * The *output* tool (structured final-result schema, e.g. pydantic-ai's
 * `output_type=`) is different: it doesn't need a round trip, so it's wired
 * through natively via `--json-schema` when the caller passes `jsonSchema`
 * (see `extractOutputToolSchema`).
 *
 * @param {{model: string, systemPrompt: string|null, streaming: boolean, jsonSchema?: object|null, mcpConfigPath?: string|null, allowedToolNames?: string[]|null}} opts
 * @returns {string[]}
 */
export function buildClaudeArgs({
  model,
  systemPrompt,
  streaming,
  jsonSchema = null,
  mcpConfigPath = null,
  allowedToolNames = null,
}) {
  const args = ["--no-session-persistence"];
  if (mcpConfigPath && allowedToolNames?.length) {
    args.push("--mcp-config", mcpConfigPath, "--strict-mcp-config");
    args.push("--allowed-tools", allowedToolNames.join(","));
  } else {
    args.push("--allowed-tools", "");
  }
  args.push("--model", model, "--output-format", streaming ? "stream-json" : "json");
  if (streaming) {
    args.push("--include-partial-messages");
    args.push("--verbose");
  }
  // Skip appending blank/whitespace-only system prompts — they add 6K+ cache
  // creation tokens per call (extra usage charges) with no benefit.
  const effectiveSystem = systemPrompt?.trim() ?? "";
  if (effectiveSystem) {
    args.push("--append-system-prompt", effectiveSystem);
  }
  if (jsonSchema) {
    args.push("--json-schema", JSON.stringify(jsonSchema));
  }
  return args;
}

/**
 * Translate claude's non-streaming `--output-format json` payload into an
 * Anthropic Messages-API response. Real CLI shape verified in Phase 0.
 *
 * Surfaces cache-token usage fields (`cache_creation_input_tokens`,
 * `cache_read_input_tokens`) — these dominate cost reporting and are part
 * of the public Anthropic API.
 *
 * When the call was made with `--json-schema` (see `buildClaudeArgs`), the
 * CLI returns a parsed `structured_output` field alongside `result`. That
 * gets surfaced as a `tool_use` content block named `final_result` — the
 * shape pydantic-ai (and similar structured-output callers) expect instead
 * of plain text, matching the CLI's own `stop_reason: "tool_use"` for that
 * case.
 */
export function claudeJsonToAnthropic(claudeOut, model) {
  const resultText = typeof claudeOut.result === "string" ? claudeOut.result : "";
  const u = claudeOut.usage ?? {};

  const content =
    claudeOut.structured_output !== undefined
      ? [{ type: "tool_use", id: `toolu_${randomUUID().replace(/-/g, "")}`, name: OUTPUT_TOOL_NAME, input: claudeOut.structured_output }]
      : [{ type: "text", text: resultText }];

  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: claudeOut.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: u.input_tokens ?? 0,
      output_tokens: u.output_tokens ?? 0,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
      cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    },
  };
}

/**
 * Normalize an OpenAI Chat Completions request body to Anthropic Messages API
 * format. Extracts a leading system message into the `system` field and strips
 * OpenAI-only fields that our downstream logic doesn't understand.
 *
 * @param {object} body raw OpenAI-format request body
 * @returns {object} Anthropic-format body ready for validateMessagesBody
 */
export function openAIBodyToAnthropic(body) {
  const messages = Array.isArray(body.messages) ? [...body.messages] : [];
  let system;
  if (messages.length > 0 && messages[0].role === "system") {
    system = typeof messages[0].content === "string"
      ? messages[0].content
      : JSON.stringify(messages[0].content);
    messages.shift();
  }
  return { model: body.model, messages, system, stream: body.stream };
}

/**
 * Convert an Anthropic Messages-API response to OpenAI Chat Completions format.
 *
 * @param {object} anthropicResp
 * @returns {object}
 */
export function anthropicToOpenAIResponse(anthropicResp) {
  const text = anthropicResp.content?.[0]?.text ?? "";
  const u = anthropicResp.usage ?? {};
  const finishReason = anthropicResp.stop_reason === "end_turn" ? "stop" : (anthropicResp.stop_reason ?? "stop");
  return {
    id: (anthropicResp.id ?? "msg_").replace(/^msg_/, "chatcmpl-"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicResp.model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: finishReason }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
    },
  };
}

/**
 * Translate one parsed line of claude's stream-json into zero or more
 * Anthropic SSE events.
 *
 * Phase 0 finding: with `--include-partial-messages`, claude emits native
 * Anthropic SSE event payloads wrapped as `{type:"stream_event", event:{…}}`.
 * The mapping is therefore a pure passthrough: unwrap `evt.event` and emit
 * it directly. All other event types (system/init, system/hook_*,
 * rate_limit_event, the final aggregated `assistant`/`result` blocks) are
 * irrelevant for SSE consumers and dropped.
 *
 * @param {object} claudeEvt one parsed JSON line from `claude` stdout
 * @returns {Array<{event: string, data: object}>|null}
 */
export function mapClaudeStreamEvent(claudeEvt) {
  if (claudeEvt?.type !== "stream_event") return null;
  const inner = claudeEvt.event;
  if (!inner || typeof inner.type !== "string") return null;
  return [{ event: inner.type, data: inner }];
}
