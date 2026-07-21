/**
 * Integration smoke against the real `claude` CLI. Gated by env:
 *   CLAUDE_PROXY_E2E=1 node --test test/integration.test.js
 *
 * Without the env var, every test is skipped — `npm test` stays fast and
 * doesn't require OAuth auth. With the env var, the test confirms the
 * subprocess we built in cli-format.js does indeed produce the JSON shape
 * we assume, and that claudeJsonToAnthropic() can map it without error.
 *
 * Strips CLAUDECODE / CLAUDE_CODE_ENTRYPOINT from the child env so the test
 * also works when run from inside a Claude Code session (the CLI otherwise
 * refuses to launch nested).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildClaudeArgs,
  claudeJsonToAnthropic,
  mapClaudeStreamEvent,
  anthropicMessagesToImagePrompt,
} from "../src/cli-format.js";

// A 32×32 solid-red PNG — small enough to inline, distinctive enough to assert
// the model actually saw it rather than guessed.
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOklEQVR4nO3RQREAQAjDwHIa8K8MMSchfPhlBZSZUNOdS+90PR5Y8AfIRMhEyETIRMhEyETIRMhEIR/gIwFENf1lpQAAAABJRU5ErkJggg==";

const E2E = process.env.CLAUDE_PROXY_E2E === "1";
const MAYBE = E2E ? test : test.skip;
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const TEST_MODEL = process.env.CLAUDE_TEST_MODEL ?? "claude-sonnet-4-6";

const subprocessEnv = (() => {
  const e = { ...process.env };
  delete e.CLAUDECODE;
  delete e.CLAUDE_CODE_ENTRYPOINT;
  return e;
})();

function runClaude(args, prompt) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_BIN, [...args, "--print", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
      env: subprocessEnv,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (c) => { stdout += c.toString(); });
    proc.stderr.on("data", (c) => { stderr += c.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0
        ? resolve({ stdout, stderr })
        : reject(new Error(`claude exit ${code}: ${stderr}`))
    );
  });
}

MAYBE("integration: --output-format json returns parseable JSON we can map", async (t) => {
  const args = buildClaudeArgs({ model: TEST_MODEL, systemPrompt: null, streaming: false });
  const { stdout } = await runClaude(args, "Say only the word pong.");
  const parsed = JSON.parse(stdout);
  t.diagnostic(`claude json keys: ${Object.keys(parsed).join(",")}`);

  const mapped = claudeJsonToAnthropic(parsed, TEST_MODEL);
  assert.equal(mapped.type, "message");
  assert.equal(mapped.role, "assistant");
  assert.equal(mapped.model, TEST_MODEL);
  assert.equal(mapped.content[0].type, "text");
  assert.ok(mapped.content[0].text.length > 0, "expected non-empty text");
  // Don't pin the exact text — the model may say "pong" or "Pong." etc.
  assert.match(mapped.content[0].text.toLowerCase(), /pong/);
});

MAYBE("integration: --output-format stream-json emits unwrappable Anthropic events", async (t) => {
  const args = buildClaudeArgs({ model: TEST_MODEL, systemPrompt: null, streaming: true });
  const { stdout } = await runClaude(args, "Count from 1 to 3.");
  const lines = stdout.split("\n").filter((l) => l.trim());
  const eventTypes = [];
  for (const line of lines) {
    const evt = JSON.parse(line);
    const mapped = mapClaudeStreamEvent(evt);
    if (mapped) for (const m of mapped) eventTypes.push(m.event);
  }
  t.diagnostic(`SSE event sequence: ${eventTypes.join(",")}`);
  // We expect at minimum a message_start, some deltas, and a message_stop.
  assert.ok(eventTypes.includes("message_start"), "missing message_start");
  assert.ok(eventTypes.includes("content_block_delta"), "missing content_block_delta");
  assert.ok(eventTypes.includes("message_stop"), "missing message_stop");
});

MAYBE("integration: image referenced via @path reaches the model as real vision", async (t) => {
  // Mirrors server.js's materializeImageBlocks + anthropicMessagesToImagePrompt:
  // write the base64 image to a temp file, substitute an @path text mention
  // for the image block, and flatten WITHOUT the <turn role="…"> wrapper —
  // the CLI resolves the mention as a real vision attachment. Same cheap
  // non-streaming --output-format json path as text-only requests.
  //
  // Two approaches were ruled out empirically before landing on this one:
  // - `--input-format stream-json` + stdin: flaky (3 repeated runs — one
  //   silently dropped the image, another failed with
  //   "error_during_execution") even though it worked most of the time.
  // - @path mention inside anthropicMessagesToPrompt's normal <turn
  //   role="user">…</turn> wrapper: the CLI treats content inside that
  //   wrapper as quoted/untrusted and refuses to read the file, replying
  //   with a request for interactive permission instead — which --print can
  //   never satisfy. Reproduced 100% reliably; only removing the wrapper
  //   fixed it.
  // This @path-without-wrapper approach was reliable across 6+ repeated runs
  // with two different images (including a multi-color, multi-text one) and
  // correctly read rendered text out of the image, not just the dominant color.
  const dir = await mkdtemp(join(tmpdir(), "hcp-vision-e2e-"));
  const imgPath = join(dir, "test.png");
  await writeFile(imgPath, Buffer.from(RED_PNG_B64, "base64"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { promptText } = anthropicMessagesToImagePrompt({
    messages: [{ role: "user", content: `Reply with only the dominant color word of this image: @${imgPath}` }],
  });
  const args = buildClaudeArgs({ model: TEST_MODEL, systemPrompt: null, streaming: false });
  const { stdout } = await runClaude(args, promptText);
  const parsed = JSON.parse(stdout);
  const mapped = claudeJsonToAnthropic(parsed, TEST_MODEL);
  const text = (mapped.content[0]?.text ?? "").toLowerCase();
  t.diagnostic(`model saw: ${text}`);
  assert.match(text, /red|rot/, "model did not identify the image as red — vision not wired through");
});
