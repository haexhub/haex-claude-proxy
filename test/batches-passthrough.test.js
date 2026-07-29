import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_CLAUDE = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("fake-claude 1.0.0\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ type: "result", result: "ok", usage: {} }));
`;

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function waitForHealthz(port, deadlineMs) {
  const end = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      fetch(`http://127.0.0.1:${port}/healthz`)
        .then((res) => (res.ok ? resolve() : Promise.reject(new Error(`healthz ${res.status}`))))
        .catch((e) => {
          if (Date.now() > end) return reject(e);
          setTimeout(tryOnce, 50);
        });
    };
    tryOnce();
  });
}

test("forwards Anthropic Message Batches for api_key credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-batches-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-subj",
    "/CN=127.0.0.1",
    "-days",
    "1",
  ], { stdio: "ignore" });

  const seen = [];
  const upstream = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === "POST" && req.url === "/v1/messages/batches") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "msgbatch_test", processing_status: "in_progress" }));
        return;
      }
      if (req.method === "GET" && req.url === "/v1/messages/batches/msgbatch_test/results") {
        res.writeHead(200, { "content-type": "application/x-jsonlines" });
        res.end('{"custom_id":"request_0","result":{"type":"errored"}}\n');
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  const upstreamPort = await listen(upstream);
  t.after(() => upstream.close());

  const fakeClaudePath = join(dir, "fake-claude.js");
  await writeFile(fakeClaudePath, FAKE_CLAUDE);
  await chmod(fakeClaudePath, 0o755);

  const proxyPort = 10000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [new URL("../src/server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      CLAUDE_BIN: fakeClaudePath,
      PROXY_RESOLVER: fileURLToPath(new URL("./fixtures/fake-api-key-resolver.js", import.meta.url)),
      FAKE_ANTHROPIC_BASE_URL: `https://127.0.0.1:${upstreamPort}`,
      FAKE_ANTHROPIC_API_KEY: "real-upstream-key",
      PROXY_ALLOWED_FORWARD_HOSTS: "127.0.0.1",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  await waitForHealthz(proxyPort, 5000);

  const createRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "proxy-session-token",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ requests: [{ custom_id: "request_0", params: { model: "claude-haiku-4-5" } }] }),
  });
  assert.equal(createRes.status, 200);
  assert.equal((await createRes.json()).id, "msgbatch_test");

  const resultsRes = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/batches/msgbatch_test/results`, {
    headers: { "x-api-key": "proxy-session-token" },
  });
  assert.equal(resultsRes.status, 200);
  assert.match(await resultsRes.text(), /"custom_id":"request_0"/);

  assert.equal(seen[0].method, "POST");
  assert.equal(seen[0].url, "/v1/messages/batches");
  assert.equal(seen[0].headers["x-api-key"], "real-upstream-key");
  assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(JSON.parse(seen[0].body), {
    requests: [{ custom_id: "request_0", params: { model: "claude-haiku-4-5" } }],
  });
  assert.equal(seen[1].method, "GET");
  assert.equal(seen[1].url, "/v1/messages/batches/msgbatch_test/results");
});

test("rejects Message Batches for non-api_key credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "hcp-batches-reject-"));
  const fakeClaudePath = join(dir, "fake-claude.js");
  await writeFile(fakeClaudePath, FAKE_CLAUDE);
  await chmod(fakeClaudePath, 0o755);

  const proxyPort = 10000 + Math.floor(Math.random() * 20000);
  const proc = spawn(process.execPath, [new URL("../src/server.js", import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(proxyPort),
      CLAUDE_BIN: fakeClaudePath,
      PROXY_RESOLVER: fileURLToPath(new URL("./fixtures/fake-api-key-resolver.js", import.meta.url)),
      FAKE_ANTHROPIC_MODE: "oauth_claude",
      FAKE_ANTHROPIC_BASE_URL: "https://127.0.0.1:1",
      FAKE_ANTHROPIC_API_KEY: "unused",
      PROXY_ALLOWED_FORWARD_HOSTS: "127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    proc.kill();
    await rm(dir, { recursive: true, force: true });
  });

  await waitForHealthz(proxyPort, 5000);

  const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages/batches`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": "proxy-session-token",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ requests: [{ custom_id: "request_0", params: { model: "claude-haiku-4-5" } }] }),
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error.message, /Anthropic api_key credential/);
});
