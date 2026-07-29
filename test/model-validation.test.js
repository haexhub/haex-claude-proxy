/**
 * Regression coverage for the model allowlist gate: POST /v1/messages and
 * /v1/chat/completions used to pass `body.model` straight through to the
 * `claude` subprocess unchecked, so a typo'd or nonexistent model name only
 * surfaced as a slow, misleading downstream error. Both handlers now reject
 * unknown models immediately against the same list GET /v1/models serves.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_CLAUDE = `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "ok",
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

async function startServer(t) {
  const dir = await mkdtemp(join(tmpdir(), "hcp-modeltest-"));
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
  return port;
}

test("POST /v1/messages rejects an unknown model without spawning claude", async (t) => {
  const port = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-definitely-not-a-real-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.type, "not_found_error");
  assert.match(body.error.message, /claude-definitely-not-a-real-model/);
});

test("POST /v1/messages accepts a known model", async (t) => {
  const port = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 200);
});

test("POST /v1/chat/completions rejects an unknown model without spawning claude", async (t) => {
  const port = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-not-a-claude-model",
      messages: [{ role: "user", content: "hi" }],
    }),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.error.type, "not_found_error");
});

test("GET /v1/models includes the current Claude 5 family", async (t) => {
  const port = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const ids = body.data.map((m) => m.id);
  assert.ok(ids.includes("claude-opus-5"), `expected claude-opus-5 in ${ids}`);
  assert.ok(ids.includes("claude-sonnet-4-6"), `expected claude-sonnet-4-6 in ${ids}`);
});
