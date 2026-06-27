/**
 * Regression test for a real incident: a prior refactor (4d0e1ab) silently
 * dropped the Messages-API `system` field for POST /v1/messages, passing
 * `systemPrompt: null` to buildClaudeArgs while claiming (in a comment) it
 * was "embedded in promptText" -- it never was. Every system-prompted call
 * through /v1/messages ran with zero system instructions for ~7 weeks.
 *
 * This spins up the real HTTP server against a fake `claude` binary that
 * just echoes its own argv back, so the test fails loudly if `handleMessages`
 * ever again forgets to thread the system text through to --append-system-prompt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A tiny Node "claude" stand-in: echoes its own argv back inside the result
// text, properly JSON-escaped (a shell one-liner using "$*" would break on
// the prompt text's embedded `<turn role="user">` quotes).
const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok ARGS:" + process.argv.slice(2).join(" "),
  usage: {},
}));
`;

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

test("handleMessages threads body.system through to --append-system-prompt", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-systest-"));
  const fakeClaudePath = join(dir, "fake-claude.sh");
  await writeFile(fakeClaudePath, FAKE_CLAUDE);
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

  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      stream: false,
      system: "MARKER_SYSTEM_PROMPT_CONTENT",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  const body = await res.json();
  const text = body.content?.[0]?.text ?? "";
  assert.match(
    text,
    /MARKER_SYSTEM_PROMPT_CONTENT/,
    `expected the fake CLI's argv (echoed in its output) to contain the system prompt marker, got: ${text}`,
  );
});
