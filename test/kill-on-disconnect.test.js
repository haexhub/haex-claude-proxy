/**
 * Regression coverage for the orphaned-CLI-process bug: a spawned `claude`
 * CLI process kept running to completion even after the calling client gave
 * up waiting and disconnected (confirmed live on 2026-08-31 — a request that
 * legitimately took 288s succeeded 48s after zvg-immo's 240s client timeout
 * had already aborted and moved on). handleMessages/handleChatCompletions
 * now call killOnDisconnect(req, proc) right after spawning, which kills the
 * process once the client's request socket closes prematurely.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fakeSlowClaudeScript(markerDir) {
  return `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const markerDir = ${JSON.stringify(markerDir)};
// /healthz probes this same CLAUDE_BIN with --version — must stay fast and
// must not touch the markers below, or it races/pollutes the real request
// under test (this bit us during development: healthz's own invocation
// silently satisfied the started/completed marker checks before the real
// request had even been sent).
if (process.argv.includes("--version")) {
  process.stdout.write("1.2.3 (fake)\\n");
  process.exit(0);
}
fs.writeFileSync(path.join(markerDir, "started"), "1");
process.on("SIGTERM", () => {
  fs.writeFileSync(path.join(markerDir, "killed"), "1");
  process.exit(1);
});
// Long enough that the test's simulated client-disconnect fires well before
// this would otherwise complete.
setTimeout(() => {
  fs.writeFileSync(path.join(markerDir, "completed"), "1");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{}" }));
  process.exit(0);
}, 3000);
`;
}

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

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

/** Sets up a temp dir with a slow fake `claude` binary and starts the proxy
 * pointed at it, returning the port and the marker dir the fake binary
 * writes started/killed/completed files into. */
async function startServerWithSlowClaude(t) {
  const dir = await mkdtemp(join(tmpdir(), "hcp-killdisconnect-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const markerDir = join(dir, "markers");
  await mkdir(markerDir, { recursive: true });
  const fakeClaudePath = join(dir, "fake-claude.js");
  await writeFile(fakeClaudePath, fakeSlowClaudeScript(markerDir));
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
  t.after(() => proc.kill());

  await waitForHealthz(port, 5000);
  return { port, markerDir };
}

async function assertKillsOnDisconnect(t, path, body) {
  const { port, markerDir } = await startServerWithSlowClaude(t);

  const controller = new AbortController();
  const fetchPromise = fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  fetchPromise.catch(() => {}); // expected to reject once we abort below

  // Give the server enough time to spawn the fake CLI (writes "started")
  // before simulating the client giving up.
  const deadline = Date.now() + 2000;
  while (!(await fileExists(join(markerDir, "started")))) {
    if (Date.now() > deadline) throw new Error("fake claude never started");
    await new Promise((r) => setTimeout(r, 20));
  }
  controller.abort();

  // Wait past SIGTERM propagation but well short of the fake CLI's 3000ms
  // "would otherwise complete" delay.
  await new Promise((r) => setTimeout(r, 500));

  assert.equal(await fileExists(join(markerDir, "killed")), true, "claude CLI should have received SIGTERM");
  assert.equal(await fileExists(join(markerDir, "completed")), false, "claude CLI should not have been left to finish");
}

test("POST /v1/messages: client disconnect kills the still-running claude CLI", async (t) => {
  await assertKillsOnDisconnect(t, "/v1/messages", {
    model: "claude-sonnet-4-6",
    max_tokens: 64,
    messages: [{ role: "user", content: "hi" }],
  });
});

test("POST /v1/chat/completions: client disconnect kills the still-running claude CLI", async (t) => {
  await assertKillsOnDisconnect(t, "/v1/chat/completions", {
    model: "claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
  });
});
