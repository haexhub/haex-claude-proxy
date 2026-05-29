import test from "node:test";
import assert from "node:assert/strict";

import { checkBearer, extractBearer } from "../src/setup-auth.js";

// ── checkBearer ──────────────────────────────────────────────────────

test("checkBearer: exact match returns true", () => {
  assert.equal(checkBearer("abc123def456", "abc123def456"), true);
});

test("checkBearer: any mismatch returns false", () => {
  assert.equal(checkBearer("abc123def456", "abc123def457"), false);
  assert.equal(checkBearer("ABCDEF", "abcdef"), false); // case-sensitive
});

test("checkBearer: length mismatch returns false (timingSafeEqual would throw without the pre-check)", () => {
  assert.equal(checkBearer("short", "much-longer-token"), false);
  assert.equal(checkBearer("much-longer-token", "short"), false);
});

test("checkBearer: non-ASCII presented bearer that would mismatch UTF-8 bytes returns false (no throw)", () => {
  // "éé" has JS string length 2 but UTF-8 byte length 4. Without the
  // byte-level check, the string-length test would match against a
  // 2-char ASCII expected and then timingSafeEqual would throw.
  assert.doesNotThrow(() => checkBearer("éé", "xx"));
  assert.equal(checkBearer("éé", "xx"), false);
  // Even if JS lengths match, bytes differ → false (no exception).
  assert.equal(checkBearer("éx", "xy"), false);
});

test("checkBearer: empty strings return false", () => {
  assert.equal(checkBearer("", ""), false);
  assert.equal(checkBearer("", "expected"), false);
  assert.equal(checkBearer("presented", ""), false);
});

test("checkBearer: non-string inputs return false", () => {
  assert.equal(checkBearer(null, "x"), false);
  assert.equal(checkBearer("x", null), false);
  assert.equal(checkBearer(undefined, "x"), false);
  assert.equal(checkBearer(123, "x"), false);
  assert.equal(checkBearer({ toString: () => "x" }, "x"), false);
});

// ── extractBearer ────────────────────────────────────────────────────

function fakeReq({ headers = {}, url = "/setup/" } = {}) {
  return { headers, url };
}

test("extractBearer: pulls token from Authorization: Bearer header", () => {
  const r = fakeReq({ headers: { authorization: "Bearer abc123" } });
  assert.equal(extractBearer(r), "abc123");
});

test("extractBearer: trims surrounding whitespace in the header", () => {
  const r = fakeReq({ headers: { authorization: "Bearer   abc123  " } });
  assert.equal(extractBearer(r), "abc123");
});

test("extractBearer: ignores non-Bearer authorization schemes", () => {
  const r = fakeReq({ headers: { authorization: "Basic dXNlcjpwYXNz" } });
  assert.equal(extractBearer(r), "");
});

test("extractBearer: falls back to ?token query parameter", () => {
  const r = fakeReq({ url: "/setup/?token=fromquery" });
  assert.equal(extractBearer(r), "fromquery");
});

test("extractBearer: header takes precedence over query", () => {
  const r = fakeReq({
    headers: { authorization: "Bearer fromheader" },
    url: "/setup/?token=fromquery",
  });
  assert.equal(extractBearer(r), "fromheader");
});

test("extractBearer: returns empty string when neither present", () => {
  assert.equal(extractBearer(fakeReq()), "");
  assert.equal(extractBearer(fakeReq({ url: "/setup/?other=x" })), "");
});

test("extractBearer: handles malformed url gracefully", () => {
  // URL constructor accepts almost anything relative to a base; we shouldn't crash.
  assert.equal(extractBearer(fakeReq({ url: "" })), "");
});

// ── Integration: checkBearer(extractBearer(req), expected) ──────────

test("integration: full middleware chain on a valid header", () => {
  const r = fakeReq({ headers: { authorization: "Bearer the-secret-token-1234" } });
  assert.equal(checkBearer(extractBearer(r), "the-secret-token-1234"), true);
});

test("integration: missing token on protected request", () => {
  assert.equal(checkBearer(extractBearer(fakeReq()), "the-secret-token"), false);
});

test("integration: wrong token via query string", () => {
  const r = fakeReq({ url: "/setup/login?token=wrong" });
  assert.equal(checkBearer(extractBearer(r), "right"), false);
});
