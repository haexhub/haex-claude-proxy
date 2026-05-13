/**
 * Unit tests for the multi-tenant session-token resolver. The DB
 * lookup is exercised against a fake `query` function — no real
 * Postgres needed for these tests. The integration with specifyr's
 * runner_sessions table is covered separately in
 * specifyr/tests/db/runner-sessions-store.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  createCredentialsStore,
  createDbLookup,
  extractSessionToken,
  looksLikeSessionToken,
  parseExpiresAt,
} from "../src/auth.js";

const VALID_TOKEN = "a".repeat(64);
const VALID_UUID = "11111111-2222-3333-4444-555555555555";

function makeReq(headers) {
  return { headers };
}

// ───── extractSessionToken ─────

test("extractSessionToken: pulls from x-api-key header", () => {
  assert.equal(extractSessionToken(makeReq({ "x-api-key": VALID_TOKEN })), VALID_TOKEN);
});

test("extractSessionToken: pulls from Bearer Authorization header", () => {
  assert.equal(
    extractSessionToken(makeReq({ authorization: `Bearer ${VALID_TOKEN}` })),
    VALID_TOKEN,
  );
});

test("extractSessionToken: case-insensitive on the Bearer scheme", () => {
  assert.equal(
    extractSessionToken(makeReq({ authorization: `bearer ${VALID_TOKEN}` })),
    VALID_TOKEN,
  );
});

test("extractSessionToken: returns null when no token-bearing header is present", () => {
  assert.equal(extractSessionToken(makeReq({})), null);
});

test("extractSessionToken: returns null for an empty Authorization header", () => {
  assert.equal(extractSessionToken(makeReq({ authorization: "" })), null);
});

test("extractSessionToken: ignores non-Bearer Authorization schemes", () => {
  assert.equal(
    extractSessionToken(makeReq({ authorization: "Basic abc" })),
    null,
  );
});

// ───── looksLikeSessionToken ─────

test("looksLikeSessionToken: accepts 64-char hex", () => {
  assert.equal(looksLikeSessionToken(VALID_TOKEN), true);
});

test("looksLikeSessionToken: rejects short string", () => {
  assert.equal(looksLikeSessionToken("abc"), false);
});

test("looksLikeSessionToken: rejects sk-ant-… legacy placeholder", () => {
  // hermes still injects this string as ANTHROPIC_API_KEY when no
  // per-user credential is configured — must NOT be treated as a
  // session token (would cause needless DB roundtrip + 401).
  assert.equal(
    looksLikeSessionToken(
      "sk-ant-api03-proxy0000000000000000000000000000000000000000000000000000000000000000",
    ),
    false,
  );
});

test("looksLikeSessionToken: rejects uppercase hex (we always emit lowercase)", () => {
  assert.equal(looksLikeSessionToken(VALID_TOKEN.toUpperCase()), false);
});

// ───── createCredentialsStore ─────

// Fake-Pool für Tests: pool.connect() liefert einen Client mit query() der
// alle Aufrufe in einer Liste sammelt; die SELECT-Query gegen llm_credentials
// returnt das vom Test vorgegebene Result. Damit testen wir RLS-Mechanik
// (set_config in einer Transaction) ohne echte DB.
function fakeStoreClient(selectRows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: sql.trim().split("\n")[0], params });
      if (sql.includes("FROM llm_credentials")) return { rows: selectRows };
      if (sql.startsWith("UPDATE llm_credentials")) return { rowCount: 1 };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); },
  };
}

function fakeStorePool(client) {
  return { async connect() { return client; } };
}

test("createCredentialsStore.load: BEGIN + set_config + SELECT + COMMIT, decrypted plaintext returned", async () => {
  const client = fakeStoreClient([{
    id: VALID_UUID,
    oauth_credentials_iv: "iv-x",
    oauth_credentials_tag: "tag-x",
    oauth_credentials_data: "data-x",
    oauth_expires_at: new Date("2030-01-01T00:00:00Z"),
  }]);
  const store = createCredentialsStore(fakeStorePool(client), (entry) => {
    assert.deepEqual(entry, { iv: "iv-x", tag: "tag-x", data: "data-x" });
    return "PLAINTEXT-JSON";
  });
  const result = await store.load("user", VALID_UUID);
  assert.equal(result.id, VALID_UUID);
  assert.equal(result.plaintext, "PLAINTEXT-JSON");
  const sqls = client.calls.map((c) => c.sql);
  assert.ok(sqls.includes("BEGIN"), "BEGIN must be issued");
  assert.ok(sqls.includes("COMMIT"), "COMMIT must be issued");
  assert.ok(
    sqls.some((s) => s.includes("set_config('app.current_owner_kind'")),
    "owner_kind must be set via set_config",
  );
  assert.ok(
    sqls.some((s) => s.includes("set_config('app.current_owner_id'")),
    "owner_id must be set via set_config",
  );
});

test("createCredentialsStore.load: returns null when no row matches", async () => {
  const client = fakeStoreClient([]);
  const store = createCredentialsStore(fakeStorePool(client), () => "");
  assert.equal(await store.load("user", VALID_UUID), null);
});

test("createCredentialsStore.load: rejects path-traversal-shaped ownerId", async () => {
  const client = fakeStoreClient([]);
  const store = createCredentialsStore(fakeStorePool(client), () => "");
  await assert.rejects(
    () => store.load("user", "../etc/passwd"),
    /invalid ownerId/,
  );
});

test("createCredentialsStore.load: rejects unknown ownerKind", async () => {
  const client = fakeStoreClient([]);
  const store = createCredentialsStore(fakeStorePool(client), () => "");
  await assert.rejects(
    () => store.load("evil", VALID_UUID),
    /invalid ownerKind/,
  );
});

// ───── parseExpiresAt ─────

test("parseExpiresAt: returns null on malformed JSON", () => {
  assert.equal(parseExpiresAt("not-json"), null);
});

test("parseExpiresAt: picks top-level numeric expiresAt", () => {
  const d = parseExpiresAt(JSON.stringify({ expiresAt: 1893456000000 }));
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1893456000000);
});

test("parseExpiresAt: picks nested claudeAiOauth.expires_at ISO", () => {
  const d = parseExpiresAt(JSON.stringify({
    claudeAiOauth: { expires_at: "2030-06-15T12:00:00Z" },
  }));
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), "2030-06-15T12:00:00.000Z");
});

test("parseExpiresAt: returns null when no expires field is present", () => {
  assert.equal(parseExpiresAt(JSON.stringify({ foo: "bar" })), null);
});

// ───── createDbLookup ─────

function fakePool(rows) {
  return {
    query: async (_sql, _params) => ({ rows }),
  };
}

test("createDbLookup: returns null for an empty result set", async () => {
  const lookup = createDbLookup(fakePool([]));
  assert.equal(await lookup(VALID_TOKEN), null);
});

test("createDbLookup: returns owner shape for a valid row", async () => {
  const lookup = createDbLookup(
    fakePool([
      {
        user_id: VALID_UUID,
        owner_kind: "user",
        owner_id: VALID_UUID,
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: null,
      },
    ]),
  );
  const r = await lookup(VALID_TOKEN);
  assert.deepEqual(r, {
    userId: VALID_UUID,
    ownerKind: "user",
    ownerId: VALID_UUID,
  });
});

test("createDbLookup: returns null for a revoked session", async () => {
  const lookup = createDbLookup(
    fakePool([
      {
        user_id: VALID_UUID,
        owner_kind: "user",
        owner_id: VALID_UUID,
        expires_at: new Date(Date.now() + 60_000),
        revoked_at: new Date(Date.now() - 1_000),
      },
    ]),
  );
  assert.equal(await lookup(VALID_TOKEN), null);
});

test("createDbLookup: returns null for an expired session", async () => {
  const lookup = createDbLookup(
    fakePool([
      {
        user_id: VALID_UUID,
        owner_kind: "user",
        owner_id: VALID_UUID,
        expires_at: new Date(Date.now() - 60_000),
        revoked_at: null,
      },
    ]),
  );
  assert.equal(await lookup(VALID_TOKEN), null);
});

test("createDbLookup: skips DB roundtrip for non-session-shaped tokens", async () => {
  let queried = false;
  const lookup = createDbLookup({
    query: async () => {
      queried = true;
      return { rows: [] };
    },
  });
  await lookup("sk-ant-api03-not-a-session-token");
  assert.equal(queried, false, "non-session-shaped tokens must short-circuit");
});

test("createDbLookup: parameterises the token (no string interpolation)", async () => {
  let receivedSql = "";
  let receivedParams = null;
  const lookup = createDbLookup({
    query: async (sql, params) => {
      receivedSql = sql;
      receivedParams = params;
      return { rows: [] };
    },
  });
  await lookup(VALID_TOKEN);
  assert.match(receivedSql, /\$1/);
  assert.deepEqual(receivedParams, [VALID_TOKEN]);
  assert.doesNotMatch(receivedSql, new RegExp(VALID_TOKEN));
});
