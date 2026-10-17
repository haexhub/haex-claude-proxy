/**
 * Regression test for a production crash: a prompt over 128 KiB as one argv
 * entry makes spawn() throw E2BIG synchronously, which killed the whole proxy
 * (34 times in 26 h) and every in-flight request with it. Large prompts now go
 * through stdin, small ones stay on argv, and a spawn failure is a 500 for
 * that request only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stand-in `claude`: if the last argv entry is not --print the prompt came via
// argv, otherwise it is read from stdin. Reports which, plus the prompt size.
const FAKE_CLAUDE = `#!/usr/bin/env node
const args = process.argv.slice(2);
const viaArgv = args[args.length - 1] !== "--print";
const finish = (prompt, via) => process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", is_error: false,
  result: "VIA:" + via + " BYTES:" + Buffer.byteLength(prompt, "utf8"), usage: {},
}));
if (viaArgv) finish(args[args.length - 1], "argv");
else {
  let data = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => { data += c; });
  process.stdin.on("end", () => finish(data, "stdin"));
}
`;

function waitForHealthz(port, deadlineMs) {
  const end = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://127.0.0.1:${port}/v1/models`)
        .then(() => resolve())
        .catch((e) => {
          if (Date.now() > end) return reject(e);
          setTimeout(tryOnce, 50);
        });
    };
    tryOnce();
  });
}

async function startProxy(t, claudeBin) {
  const dir = await mkdtemp(join(tmpdir(), "hcp-large-"));
  const fakeClaudePath = claudeBin ?? join(dir, "fake-claude.js");
  if (!claudeBin) {
    await writeFile(fakeClaudePath, FAKE_CLAUDE);
    await chmod(fakeClaudePath, 0o755);
  }
  const credentialsHome = join(dir, "creds");
  await mkdir(join(credentialsHome, ".claude"), { recursive: true });
  await writeFile(join(credentialsHome, ".claude", ".credentials.json"), "{}");
  const port = 10000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [new URL("../src/server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: String(port), PROXY_RESOLVER: "file", PROXY_CREDENTIALS_HOME: credentialsHome, CLAUDE_BIN: fakeClaudePath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });
  await waitForHealthz(port, 5000);
  return { port, proc };
}

async function ask(port, text) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 64, stream: false, messages: [{ role: "user", content: text }] }),
  });
  return { status: res.status, body: await res.json() };
}

test("a prompt over 128 KiB (Cyrillic) is sent via stdin and does not crash the proxy", async (t) => {
  const { port, proc } = await startProxy(t);
  let exited = false;
  proc.on("exit", () => { exited = true; });

  // 78,166 characters * 2 bytes, the size that crashed production.
  const { status, body } = await ask(port, "д".repeat(78_166));
  assert.equal(status, 200);
  const text = body.content?.[0]?.text ?? "";
  assert.match(text, /VIA:stdin/);
  assert.ok(Number(/BYTES:(\d+)/.exec(text)?.[1]) > 131_072, `expected the full >128 KiB prompt, got: ${text}`);
  assert.equal(exited, false, "the proxy process must survive");

  // and it still answers afterwards
  const again = await ask(port, "hi");
  assert.equal(again.status, 200);
  assert.match(again.body.content?.[0]?.text ?? "", /VIA:argv/);
});

test("a small prompt keeps using argv", async (t) => {
  const { port } = await startProxy(t);
  const { status, body } = await ask(port, "hallo");
  assert.equal(status, 200);
  assert.match(body.content?.[0]?.text ?? "", /VIA:argv/);
});

test("a spawn failure fails only that request, not the process", async (t) => {
  const { port, proc } = await startProxy(t, "/nonexistent/claude-binary");
  let exited = false;
  proc.on("exit", () => { exited = true; });
  const { status } = await ask(port, "hi");
  assert.ok(status >= 400, `expected an error status, got ${status}`);
  assert.equal(exited, false, "the proxy process must survive a failed spawn");
});

test("/healthz with an unusable CLI answers 500 once and keeps the process alive", async (t) => {
  const { port, proc } = await startProxy(t, "/nonexistent/claude-binary");
  let exited = false;
  proc.on("exit", () => { exited = true; });
  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 500);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(exited, false, "double response on a failed spawn must not crash the proxy");
});
