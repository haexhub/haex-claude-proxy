/**
 * Regression test for a real incident: bufferedThenSSE assumed the block it
 * streams is always text (`content?.[0]?.text ?? ""`). Once structured output
 * landed (c265416), a `--json-schema` call produces a `tool_use` block instead
 * — which has no `.text`, so every streaming structured-output call got an
 * EMPTY text block and no tool call at all, while `stop_reason: "tool_use"`
 * was still forwarded. pydantic-ai answered that with "Please return text or
 * include your response in a tool call", retried three times and failed the
 * run; each retry had already paid for the model's full work. Every fwbg-agents
 * agent was dead for a week.
 *
 * Spins up the real HTTP server against a fake `claude` binary and asserts both
 * SSE branches: structured output becomes a real tool_use block, plain text
 * stays a text block.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const STRUCTURED_OUTPUT = { city: "Paris", population: 2145906 };
const PLAIN_TEXT = "Paris has about 2.1 million inhabitants.";

/** Stand-in for a `claude` invocation returning `claudeOut` as its JSON output. */
function fakeClaude(claudeOut) {
  return `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(claudeOut))});
`;
}

// What the CLI returns for a `--json-schema` call: the parsed object in
// `structured_output` alongside the raw `result` text.
const FAKE_STRUCTURED = fakeClaude({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(STRUCTURED_OUTPUT),
  structured_output: STRUCTURED_OUTPUT,
  stop_reason: "tool_use",
  usage: { input_tokens: 10, output_tokens: 20 },
});

// What it returns without `--json-schema`: text only, no structured_output.
const FAKE_TEXT = fakeClaude({
  type: "result",
  subtype: "success",
  is_error: false,
  result: PLAIN_TEXT,
  usage: { input_tokens: 10, output_tokens: 20 },
});

function waitForHealthz(port, deadlineMs) {
  const end = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://127.0.0.1:${port}/healthz`)
        .then(() => resolve())
        .catch((e) => {
          if (Date.now() > end) return reject(e);
          setTimeout(tryOnce, 50);
        });
    };
    tryOnce();
  });
}

/** Parse an SSE body into `{event, data}` records. */
function parseSSE(raw) {
  const out = [];
  for (const chunk of raw.split("\n\n")) {
    const event = /^event:\s*(.+)$/m.exec(chunk)?.[1];
    const data = /^data:\s*(.+)$/m.exec(chunk)?.[1];
    if (event && data) out.push({ event, data: JSON.parse(data) });
  }
  return out;
}

async function startServer(t, fakeClaudeSource) {
  const dir = await mkdtemp(join(tmpdir(), "hcp-ssetest-"));
  const fakeClaudePath = join(dir, "fake-claude.js");
  await writeFile(fakeClaudePath, fakeClaudeSource);
  await chmod(fakeClaudePath, 0o755);

  const credentialsHome = join(dir, "creds");
  await mkdir(join(credentialsHome, ".claude"), { recursive: true });
  await writeFile(join(credentialsHome, ".claude", ".credentials.json"), "{}");

  const port = 10000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [new URL("../src/server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(port),
      PROXY_RESOLVER: "file",
      PROXY_CREDENTIALS_HOME: credentialsHome,
      CLAUDE_BIN: fakeClaudePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await waitForHealthz(port, 5000);
  return port;
}

function streamRequest(port, body) {
  return fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "capital of France" }],
      ...body,
    }),
  });
}

const OUTPUT_TOOL = {
  name: "final_result",
  description: "Emit the final structured answer",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" }, population: { type: "integer" } },
    required: ["city", "population"],
  },
};

test("streaming structured output arrives as a tool_use block, not empty text", async (t) => {
  const port = await startServer(t, FAKE_STRUCTURED);
  const res = await streamRequest(port, { tools: [OUTPUT_TOOL] });
  const events = parseSSE(await res.text());

  const start = events.find((e) => e.event === "content_block_start");
  assert.equal(
    start?.data.content_block?.type,
    "tool_use",
    `expected a tool_use content block, got ${JSON.stringify(start?.data.content_block)}`,
  );
  assert.equal(start.data.content_block.name, "final_result");
  assert.ok(start.data.content_block.id, "tool_use block needs an id");

  const deltas = events.filter((e) => e.event === "content_block_delta");
  assert.ok(deltas.length > 0, "expected at least one content_block_delta");
  assert.ok(
    deltas.every((d) => d.data.delta?.type === "input_json_delta"),
    "a tool_use block must only carry input_json_delta chunks",
  );
  assert.deepEqual(
    JSON.parse(deltas.map((d) => d.data.delta.partial_json).join("")),
    STRUCTURED_OUTPUT,
  );

  assert.equal(
    events.find((e) => e.event === "message_delta")?.data.delta?.stop_reason,
    "tool_use",
  );
});

test("streaming plain text still arrives as a text block", async (t) => {
  const port = await startServer(t, FAKE_TEXT);
  const res = await streamRequest(port, {});
  const events = parseSSE(await res.text());

  assert.equal(events.find((e) => e.event === "content_block_start")?.data.content_block?.type, "text");
  const deltas = events.filter((e) => e.event === "content_block_delta");
  assert.deepEqual(
    deltas.map((d) => d.data.delta.text).join(""),
    PLAIN_TEXT,
  );
});
