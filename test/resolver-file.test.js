import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { create } from "../src/resolvers/file.js";

async function makeHome(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-file-"));
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".claude", ".credentials.json"),
    contents,
    "utf8",
  );
  return dir;
}

test("file resolver: returns oauth_claude with HOME pointing at PROXY_CREDENTIALS_HOME", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const resolver = create({ PROXY_CREDENTIALS_HOME: home });
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.mode, "oauth_claude");
  assert.equal(result.home, home);
  assert.equal(result.credId, "file");
  assert.equal(result.persistent, true);
  assert.equal(resolver.name, "file");
});

test("file resolver: 503 when PROXY_CREDENTIALS_HOME is unset", async () => {
  const resolver = create({});
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.error?.status, 503);
  assert.match(result.error.message, /PROXY_CREDENTIALS_HOME/);
});

test("file resolver: 503 when .credentials.json missing in HOME", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-empty-"));
  const resolver = create({ PROXY_CREDENTIALS_HOME: empty });
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.error?.status, 503);
  assert.match(result.error.message, /credentials\.json/);
});

test("file resolver: writeback is a no-op", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const resolver = create({ PROXY_CREDENTIALS_HOME: home });
  // Contract: writeback exists, returns a promise, doesn't throw, doesn't
  // mutate anything visible.
  await resolver.writeback({ mode: "oauth_claude", home }, "new contents");
  // No exception — pass.
});

test("file resolver: ignores session token header", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const resolver = create({ PROXY_CREDENTIALS_HOME: home });
  const result = await resolver.resolve({ headers: { "x-api-key": "anything-at-all" } });
  // FileResolver is single-user: token header is irrelevant.
  assert.equal(result.mode, "oauth_claude");
});

test("file resolver: factory does not throw when PROXY_CREDENTIALS_HOME is missing", () => {
  // Boot-time errors prevent /healthz from working; we want errors at
  // request time so operators can observe a running-but-misconfigured proxy.
  assert.doesNotThrow(() => create({}));
});
