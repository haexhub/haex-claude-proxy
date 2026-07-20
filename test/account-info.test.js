import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createAccountInfoReader } from "../src/account-info.js";

async function makeHome(creds) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-account-info-"));
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".claude", ".credentials.json"),
    JSON.stringify(creds),
    "utf8",
  );
  return dir;
}

test("account-info: reads organizationUuid and subscriptionType from disk, email from profile fetch", async () => {
  const home = await makeHome({
    claudeAiOauth: { accessToken: "tok-123", subscriptionType: "team" },
    organizationUuid: "org-abc",
  });
  let calledWith = null;
  const reader = createAccountInfoReader({
    fetchImpl: async (url, opts) => {
      calledWith = { url, opts };
      return {
        ok: true,
        json: async () => ({ emailAddress: "person@example.com" }),
      };
    },
  });

  const info = await reader.get(home);
  assert.deepEqual(info, {
    organizationUuid: "org-abc",
    subscriptionType: "team",
    emailAddress: "person@example.com",
  });
  assert.equal(calledWith.url, "https://api.anthropic.com/api/oauth/profile");
  assert.equal(calledWith.opts.headers.authorization, "Bearer tok-123");
});

test("account-info: returns null when credentials.json is missing", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-account-info-empty-"));
  const reader = createAccountInfoReader({ fetchImpl: async () => { throw new Error("should not be called"); } });
  const info = await reader.get(empty);
  assert.equal(info, null);
});

test("account-info: degrades to local fields when the profile fetch fails", async () => {
  const home = await makeHome({
    claudeAiOauth: { accessToken: "tok-123", subscriptionType: "team" },
    organizationUuid: "org-abc",
  });
  const reader = createAccountInfoReader({
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  const info = await reader.get(home);
  assert.deepEqual(info, {
    organizationUuid: "org-abc",
    subscriptionType: "team",
    emailAddress: null,
  });
});

test("account-info: caches the result within the TTL, keyed by home", async () => {
  const home = await makeHome({
    claudeAiOauth: { accessToken: "tok-123", subscriptionType: "team" },
    organizationUuid: "org-abc",
  });
  let calls = 0;
  let clock = 0;
  const reader = createAccountInfoReader({
    fetchImpl: async () => {
      calls += 1;
      return { ok: true, json: async () => ({ emailAddress: "person@example.com" }) };
    },
    now: () => clock,
    cacheTtlMs: 1000,
  });

  await reader.get(home);
  clock += 500;
  await reader.get(home);
  assert.equal(calls, 1, "second call within TTL should reuse the cache");

  clock += 600; // now 1100ms since first fetch, past the 1000ms TTL
  await reader.get(home);
  assert.equal(calls, 2, "call past the TTL should refetch");
});

test("account-info: missing accessToken skips the profile fetch", async () => {
  const home = await makeHome({ organizationUuid: "org-abc" });
  const reader = createAccountInfoReader({
    fetchImpl: async () => { throw new Error("should not be called without an access token"); },
  });

  const info = await reader.get(home);
  assert.deepEqual(info, {
    organizationUuid: "org-abc",
    subscriptionType: null,
    emailAddress: null,
  });
});
