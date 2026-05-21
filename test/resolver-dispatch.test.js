import test from "node:test";
import assert from "node:assert/strict";

import { createResolver } from "../src/resolvers/index.js";

test("createResolver throws on unknown PROXY_RESOLVER value", async () => {
  await assert.rejects(
    () => createResolver({ PROXY_RESOLVER: "bogus" }),
    /unknown resolver/i,
  );
});

test("createResolver returns a resolver with name=file by default", async () => {
  const r = await createResolver({ PROXY_RESOLVER: undefined, PROXY_CREDENTIALS_HOME: "/tmp" });
  assert.equal(r.name, "file");
  assert.equal(typeof r.resolve, "function");
});
