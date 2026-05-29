import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a presented bearer against the expected
 * token. Returns false on any mismatch (including length differences,
 * missing/empty token, non-string input).
 *
 * `timingSafeEqual` throws on length mismatch, so we gate on the
 * UTF-8 byte length of the buffers rather than the JS string length
 * (`.length` counts UTF-16 code units — `"é".length === 1` but
 * `Buffer.from("é").length === 2`). The expected token is ASCII by
 * construction (validated against /^[A-Za-z0-9._~-]+$/ at boot in
 * server.js), so the only realistic vector here is a client sending
 * a non-ASCII presented bearer — without the byte-level check, that
 * would crash the worker with an uncaught exception, a trivial DoS.
 *
 * The length itself isn't secret — for a 64-hex token (`openssl rand
 * -hex 32`) it's a public protocol constant, not a credential.
 *
 * Extracted into its own file so the server's HTTP layer can be tested
 * without dragging the full server.js init (resolver, node-pty dynamic
 * import, etc.) into the test.
 */
export function checkBearer(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (presented.length === 0 || expected.length === 0) return false;
  const presentedBuf = Buffer.from(presented, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (presentedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(presentedBuf, expectedBuf);
}

/**
 * Pull the bearer out of either the `Authorization: Bearer …` header
 * or a `?token=…` query parameter. The query form is the bootstrap
 * path — the operator opens the setup page from a URL the deployment
 * playbook puts in their hands; subsequent fetches from the page's JS
 * use the header form.
 *
 * Returns the empty string when neither is present (caller checks).
 */
export function extractBearer(req) {
  const h = req.headers["authorization"];
  if (typeof h === "string" && h.startsWith("Bearer ")) {
    return h.slice("Bearer ".length).trim();
  }
  // req.url is always relative for incoming requests; resolve against a
  // dummy origin so URL() parses the query string.
  if (typeof req.url === "string") {
    const q = new URL(req.url, "http://internal").searchParams.get("token");
    if (q) return q.trim();
  }
  return "";
}
