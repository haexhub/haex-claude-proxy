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
 * Build the argv (excluding the trailing `--print PROMPT`) for spawning the
 * `claude` subprocess. Tools are intentionally disabled — the model surfaces
 * tool intents as content blocks but won't execute anything.
 *
 * @param {{model: string, systemPrompt: string|null, streaming: boolean}} opts
 * @returns {string[]}
 */
export function buildClaudeArgs({ model, systemPrompt, streaming }) {
  const args = [
    "--no-session-persistence",
    "--allowed-tools", "",
    "--model", model,
    "--output-format", streaming ? "stream-json" : "json",
  ];
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
  return args;
}

/**
 * Translate claude's non-streaming `--output-format json` payload into an
 * Anthropic Messages-API response. Real CLI shape verified in Phase 0.
 *
 * Surfaces cache-token usage fields (`cache_creation_input_tokens`,
 * `cache_read_input_tokens`) — these dominate cost reporting and are part
 * of the public Anthropic API.
 */
export function claudeJsonToAnthropic(claudeOut, model) {
  const resultText = typeof claudeOut.result === "string" ? claudeOut.result : "";
  const u = claudeOut.usage ?? {};

  return {
    id: `msg_${randomUUID().replace(/-/g, "")}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: resultText }],
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
