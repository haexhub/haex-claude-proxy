import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  validateMessagesBody,
  anthropicMessagesToPrompt,
  flattenContent,
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
} from "../src/cli-format.js";

const here = dirname(fileURLToPath(import.meta.url));

// ───── validateMessagesBody ─────

test("validateMessagesBody: accepts well-formed body", () => {
  const r = validateMessagesBody({
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(r, { ok: true });
});

test("validateMessagesBody: rejects null body", () => {
  assert.equal(validateMessagesBody(null).ok, false);
});

test("validateMessagesBody: rejects array body", () => {
  assert.equal(validateMessagesBody([]).ok, false);
});

test("validateMessagesBody: rejects missing model", () => {
  const r = validateMessagesBody({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /model/);
});

test("validateMessagesBody: rejects empty messages", () => {
  const r = validateMessagesBody({ model: "x", messages: [] });
  assert.equal(r.ok, false);
  assert.match(r.error, /messages/);
});

test("validateMessagesBody: rejects invalid role", () => {
  const r = validateMessagesBody({
    model: "x",
    messages: [{ role: "system", content: "x" }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /role/);
});

test("validateMessagesBody: rejects null content", () => {
  const r = validateMessagesBody({
    model: "x",
    messages: [{ role: "user", content: null }],
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /content/);
});

// ───── flattenContent ─────

test("flattenContent: passes string through", () => {
  assert.equal(flattenContent("hello"), "hello");
});

test("flattenContent: joins text blocks with newlines", () => {
  assert.equal(
    flattenContent([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
});

test("flattenContent: serializes tool_use blocks", () => {
  const out = flattenContent([
    { type: "tool_use", id: "tu_1", name: "foo", input: { x: 1 } },
  ]);
  assert.match(out, /<tool_use name="foo" id="tu_1">/);
  assert.match(out, /\{"x":1\}/);
});

test("flattenContent: nests tool_result content", () => {
  const out = flattenContent([
    { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
  ]);
  assert.match(out, /<tool_result tool_use_id="tu_1">result text<\/tool_result>/);
});

// ───── anthropicMessagesToPrompt ─────

test("anthropicMessagesToPrompt: flattens single-turn user message", () => {
  const { promptText, systemText } = anthropicMessagesToPrompt({
    model: "claude-sonnet-4-6",
    system: "You are helpful",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(systemText, "You are helpful");
  assert.match(promptText, /<turn role="user">hi<\/turn>/);
});

test("anthropicMessagesToPrompt: preserves multi-turn order", () => {
  const { promptText } = anthropicMessagesToPrompt({
    model: "x",
    messages: [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ],
  });
  const idxQ1 = promptText.indexOf('role="user">Q1');
  const idxA1 = promptText.indexOf('role="assistant">A1');
  const idxQ2 = promptText.indexOf('role="user">Q2');
  assert.ok(idxQ1 >= 0 && idxA1 > idxQ1 && idxQ2 > idxA1, "turns preserved in order");
});

test("anthropicMessagesToPrompt: includes tools spec when provided", () => {
  const { promptText } = anthropicMessagesToPrompt({
    model: "x",
    messages: [{ role: "user", content: "x" }],
    tools: [{ name: "foo", description: "Does foo", input_schema: { type: "object" } }],
  });
  assert.match(promptText, /<available_tools>/);
  assert.match(promptText, /foo: Does foo/);
});

test("anthropicMessagesToPrompt: emits null systemText when no system", () => {
  const { systemText } = anthropicMessagesToPrompt({
    model: "x",
    messages: [{ role: "user", content: "x" }],
  });
  assert.equal(systemText, null);
});

// ───── buildClaudeArgs ─────

test("buildClaudeArgs: non-streaming uses json output, no partial-messages", () => {
  const args = buildClaudeArgs({ model: "claude-sonnet-4-6", systemPrompt: null, streaming: false });
  assert.ok(args.includes("--output-format"));
  const fmtIdx = args.indexOf("--output-format");
  assert.equal(args[fmtIdx + 1], "json");
  assert.ok(!args.includes("--include-partial-messages"));
  assert.ok(!args.includes("--verbose"));
  assert.ok(args.includes("--no-session-persistence"));
  assert.ok(args.includes("--allowed-tools"));
});

test("buildClaudeArgs: streaming adds stream-json + partial messages + verbose", () => {
  const args = buildClaudeArgs({ model: "x", systemPrompt: null, streaming: true });
  const fmtIdx = args.indexOf("--output-format");
  assert.equal(args[fmtIdx + 1], "stream-json");
  assert.ok(args.includes("--include-partial-messages"));
  assert.ok(args.includes("--verbose"));
});

test("buildClaudeArgs: includes system prompt when provided", () => {
  const args = buildClaudeArgs({ model: "x", systemPrompt: "Be concise.", streaming: false });
  const idx = args.indexOf("--append-system-prompt");
  assert.equal(args[idx + 1], "Be concise.");
});

// ───── claudeJsonToAnthropic ─────

test("claudeJsonToAnthropic: maps result text to content array", () => {
  const r = claudeJsonToAnthropic({ result: "hello", usage: { input_tokens: 5, output_tokens: 2 } }, "claude-sonnet-4-6");
  assert.equal(r.type, "message");
  assert.equal(r.role, "assistant");
  assert.equal(r.model, "claude-sonnet-4-6");
  assert.deepEqual(r.content, [{ type: "text", text: "hello" }]);
  assert.equal(r.usage.input_tokens, 5);
  assert.equal(r.usage.output_tokens, 2);
});

test("claudeJsonToAnthropic: surfaces cache token fields when present", () => {
  const r = claudeJsonToAnthropic(
    {
      result: "x",
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        cache_creation_input_tokens: 4376,
        cache_read_input_tokens: 26816,
      },
    },
    "x",
  );
  assert.equal(r.usage.cache_creation_input_tokens, 4376);
  assert.equal(r.usage.cache_read_input_tokens, 26816);
});

test("claudeJsonToAnthropic: defaults cache fields to 0 when missing", () => {
  const r = claudeJsonToAnthropic({ result: "x", usage: {} }, "x");
  assert.equal(r.usage.cache_creation_input_tokens, 0);
  assert.equal(r.usage.cache_read_input_tokens, 0);
});

test("claudeJsonToAnthropic: defaults stop_reason to end_turn when null", () => {
  const r = claudeJsonToAnthropic({ result: "x", stop_reason: null, usage: {} }, "x");
  assert.equal(r.stop_reason, "end_turn");
});

test("claudeJsonToAnthropic: id is fresh msg_<uuid>", () => {
  const r1 = claudeJsonToAnthropic({ result: "x", usage: {} }, "x");
  const r2 = claudeJsonToAnthropic({ result: "x", usage: {} }, "x");
  assert.match(r1.id, /^msg_[0-9a-f]{32}$/);
  assert.notEqual(r1.id, r2.id);
});

// ───── mapClaudeStreamEvent ─────

test("mapClaudeStreamEvent: drops non-stream_event types", () => {
  assert.equal(mapClaudeStreamEvent({ type: "system", subtype: "init" }), null);
  assert.equal(mapClaudeStreamEvent({ type: "rate_limit_event" }), null);
  assert.equal(mapClaudeStreamEvent({ type: "result", subtype: "success" }), null);
  assert.equal(mapClaudeStreamEvent({ type: "assistant", message: {} }), null);
});

test("mapClaudeStreamEvent: drops malformed stream_event without inner type", () => {
  assert.equal(mapClaudeStreamEvent({ type: "stream_event" }), null);
  assert.equal(mapClaudeStreamEvent({ type: "stream_event", event: {} }), null);
  assert.equal(mapClaudeStreamEvent({ type: "stream_event", event: { type: 123 } }), null);
});

test("mapClaudeStreamEvent: defensive nulls", () => {
  assert.equal(mapClaudeStreamEvent(null), null);
  assert.equal(mapClaudeStreamEvent(undefined), null);
});

test("mapClaudeStreamEvent: passes message_start through 1:1", () => {
  const evt = {
    type: "stream_event",
    event: { type: "message_start", message: { id: "msg_x", role: "assistant" } },
  };
  const r = mapClaudeStreamEvent(evt);
  assert.equal(r.length, 1);
  assert.equal(r[0].event, "message_start");
  assert.deepEqual(r[0].data, evt.event);
});

test("mapClaudeStreamEvent: passes content_block_delta through 1:1", () => {
  const evt = {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
  };
  const [out] = mapClaudeStreamEvent(evt);
  assert.equal(out.event, "content_block_delta");
  assert.equal(out.data.delta.text, "hi");
});

// ───── End-to-end fixture: real captured trace ─────

test("real fixture: only stream_event lines emit SSE events", () => {
  const lines = readFileSync(join(here, "fixtures", "stream-trace.jsonl"), "utf8")
    .trim()
    .split("\n");
  const emitted = [];
  for (const line of lines) {
    const mapped = mapClaudeStreamEvent(JSON.parse(line));
    if (mapped) for (const m of mapped) emitted.push(m.event);
  }
  assert.deepEqual(emitted, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
});

test("real fixture: text_delta concatenation reconstructs assistant text", () => {
  const lines = readFileSync(join(here, "fixtures", "stream-trace.jsonl"), "utf8")
    .trim()
    .split("\n");
  let assembled = "";
  for (const line of lines) {
    const mapped = mapClaudeStreamEvent(JSON.parse(line));
    if (!mapped) continue;
    for (const m of mapped) {
      if (m.event === "content_block_delta" && m.data.delta?.type === "text_delta") {
        assembled += m.data.delta.text;
      }
    }
  }
  assert.equal(assembled, "1, 2, 3");
});
