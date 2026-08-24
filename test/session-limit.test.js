/**
 * Regression coverage for the Claude Code CLI's own session-usage-limit
 * notice ("You've hit your session limit · resets 8:10am (UTC)"): it exits
 * non-zero with the message on stdout and empty stderr, indistinguishable
 * from a genuine per-request failure by exit code alone. Handlers now report
 * this as 429 rate_limit_error instead of a plain 502 so callers can apply
 * their existing rate-limit retry/backoff instead of treating it like a
 * broken request.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_CLAUDE_SESSION_LIMIT = `#!/usr/bin/env node
process.stdout.write("You've hit your session limit \\u00b7 resets 8:10am (UTC)\\n");
process.exit(1);
`;

const FAKE_CLAUDE_OTHER_FAILURE = `#!/usr/bin/env node
process.stderr.write("some unrelated crash\\n");
process.exit(1);
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

async function startServer(t, fakeClaudeScript) {
  const dir = await mkdtemp(join(tmpdir(), "hcp-sessionlimit-"));
  const fakeClaudePath = join(dir, "fake-claude.js");
  await writeFile(fakeClaudePath, fakeClaudeScript);
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

test("POST /v1/messages reports the session-limit notice as 429, not 502", async (t) => {
  const port = await startServer(t, FAKE_CLAUDE_SESSION_LIMIT);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, "rate_limit_error");
  assert.match(body.error.message, /session limit/i);
});

test("POST /v1/chat/completions reports the session-limit notice as 429, not 502", async (t) => {
  const port = await startServer(t, FAKE_CLAUDE_SESSION_LIMIT);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.error.type, "rate_limit_error");
});

test("POST /v1/messages still reports an unrelated claude failure as 502", async (t) => {
  const port = await startServer(t, FAKE_CLAUDE_OTHER_FAILURE);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.type, "api_error");
});
