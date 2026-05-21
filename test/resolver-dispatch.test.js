import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createResolver } from "../src/resolvers/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("createResolver returns a resolver with name=file by default", async () => {
  const r = await createResolver({ PROXY_RESOLVER: undefined });
  assert.equal(r.name, "file");
  assert.equal(typeof r.resolve, "function");
});

test("createResolver routes file builtin", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "file" });
  assert.equal(r.name, "file");
});

test("createResolver routes token-map builtin", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "token-map" });
  assert.equal(r.name, "token-map");
});

test("createResolver normalises builtin name case", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "FILE" });
  assert.equal(r.name, "file");
});

test("createResolver throws clear error when external resolver module not found", async () => {
  await assert.rejects(
    () => createResolver({ PROXY_RESOLVER: "haex-claude-proxy-resolver-nonexistent" }),
    (err) =>
      err instanceof Error
      && /haex-claude-proxy-resolver-nonexistent/.test(err.message)
      && /not found/i.test(err.message),
  );
});

test("createResolver loads external resolver module by absolute path", async () => {
  // Fixture exports create(env) returning { name, resolve } — the
  // dispatcher should accept any specifier import() can resolve.
  const fixture = path.join(__dirname, "fixtures", "fake-resolver.js");
  const r = await createResolver({ PROXY_RESOLVER: fixture });
  assert.equal(r.name, "fake");
  assert.equal(typeof r.resolve, "function");
});

test("createResolver throws when external module lacks create() export", async () => {
  const fixture = path.join(__dirname, "fixtures", "fake-resolver-bad.js");
  await assert.rejects(
    () => createResolver({ PROXY_RESOLVER: fixture }),
    /must export create\(env\)/,
  );
});
