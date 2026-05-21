import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { create } from "../src/resolvers/token-map.js";

async function makeHome(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-home-"));
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".claude", ".credentials.json"),
    contents,
    "utf8",
  );
  return dir;
}

async function writeMap(map) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-"));
  const file = path.join(dir, "tokens.json");
  await fs.writeFile(file, JSON.stringify(map), "utf8");
  return file;
}

test("token-map resolver: throws on boot when PROXY_TOKEN_MAP is unset", async () => {
  await assert.rejects(
    () => create({}),
    /PROXY_TOKEN_MAP/,
  );
});

test("token-map resolver: throws on boot when PROXY_TOKEN_MAP file is unparseable", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-bad-"));
  const badFile = path.join(dir, "bad.json");
  await fs.writeFile(badFile, "{not json", "utf8");
  await assert.rejects(
    () => create({ PROXY_TOKEN_MAP: badFile }),
    /PROXY_TOKEN_MAP/,
  );
});

test("token-map resolver: throws on boot when map root is not an object", async () => {
  const mapPath = await writeMap([]);
  await assert.rejects(
    () => create({ PROXY_TOKEN_MAP: mapPath }),
    /PROXY_TOKEN_MAP must be a JSON object/,
  );
});

test("token-map resolver: 401 when no token header", async () => {
  const home = await makeHome("{}");
  const mapPath = await writeMap({ "tok-a": { home } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.error?.status, 401);
});

test("token-map resolver: 401 on unknown token", async () => {
  const home = await makeHome("{}");
  const mapPath = await writeMap({ "tok-known": { home } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  const result = await resolver.resolve({ headers: { "x-api-key": "tok-unknown" } });
  assert.equal(result.error?.status, 401);
});

test("token-map resolver: maps token from x-api-key to oauth_claude home", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const mapPath = await writeMap({ "tok-vscode": { home } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  const result = await resolver.resolve({ headers: { "x-api-key": "tok-vscode" } });
  assert.equal(result.mode, "oauth_claude");
  assert.equal(result.home, home);
  assert.equal(result.credId, "tok-vscode");
  assert.equal(result.persistent, true);
  assert.equal(resolver.name, "token-map");
});

test("token-map resolver: maps token from Bearer Authorization to oauth_claude home", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const mapPath = await writeMap({ "tok-signal": { home } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  const result = await resolver.resolve({
    headers: { authorization: "Bearer tok-signal" },
  });
  assert.equal(result.mode, "oauth_claude");
  assert.equal(result.home, home);
});

test("token-map resolver: 503 when mapped HOME has no .credentials.json", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-empty-"));
  const mapPath = await writeMap({ "tok-broken": { home: empty } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  const result = await resolver.resolve({ headers: { "x-api-key": "tok-broken" } });
  assert.equal(result.error?.status, 503);
  assert.match(result.error.message, /credentials\.json/);
});

test("token-map resolver: writeback is a no-op", async () => {
  const home = await makeHome("{}");
  const mapPath = await writeMap({ "tok-x": { home } });
  const resolver = await create({ PROXY_TOKEN_MAP: mapPath });
  await resolver.writeback({ mode: "oauth_claude", home }, "new contents");
  // No exception — pass.
});
