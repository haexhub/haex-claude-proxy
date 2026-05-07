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
  createDbLookup,
  extractSessionToken,
  homeForOwner,
  looksLikeSessionToken,
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

// ───── homeForOwner ─────

test("homeForOwner: builds /credentials/user/<uuid>", () => {
  assert.equal(
    homeForOwner("/credentials", "user", VALID_UUID),
    `/credentials/user/${VALID_UUID}`,
  );
});

test("homeForOwner: builds /credentials/org/<uuid>", () => {
  assert.equal(
    homeForOwner("/credentials", "org", VALID_UUID),
    `/credentials/org/${VALID_UUID}`,
  );
});

test("homeForOwner: rejects unknown ownerKind", () => {
  assert.throws(
    () => homeForOwner("/credentials", "evil", VALID_UUID),
    /invalid ownerKind/,
  );
});

test("homeForOwner: rejects non-UUID ownerId (path-traversal guard)", () => {
  assert.throws(
    () => homeForOwner("/credentials", "user", "../etc/passwd"),
    /invalid ownerId/,
  );
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
