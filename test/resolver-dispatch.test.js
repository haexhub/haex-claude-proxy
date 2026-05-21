import test from "node:test";
import assert from "node:assert/strict";

import { createResolver } from "../src/resolvers/index.js";

test("createResolver throws on unknown PROXY_RESOLVER value", async () => {
  await assert.rejects(
    () => createResolver({ PROXY_RESOLVER: "bogus" }),
    (err) => err instanceof Error
      && /bogus/.test(err.message)
      && /file\|token-map\|pg-encrypted/.test(err.message),
  );
});

test("createResolver returns a resolver with name=file by default", async () => {
  const r = await createResolver({ PROXY_RESOLVER: undefined });
  assert.equal(r.name, "file");
  assert.equal(typeof r.resolve, "function");
});

test("createResolver routes token-map", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "token-map" });
  assert.equal(r.name, "token-map");
});

test("createResolver routes pg-encrypted", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "pg-encrypted" });
  assert.equal(r.name, "pg-encrypted");
});

test("createResolver normalises PROXY_RESOLVER case", async () => {
  const r = await createResolver({ PROXY_RESOLVER: "FILE" });
  assert.equal(r.name, "file");
});
