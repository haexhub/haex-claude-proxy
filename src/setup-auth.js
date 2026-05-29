import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of a presented bearer against the expected
 * token. Returns false on any mismatch (including length differences,
 * missing/empty token, non-string input).
 *
 * `timingSafeEqual` requires equal-length inputs, so the explicit
 * length check above it is the gate. The length itself is therefore
 * NOT secret — but for a 64-hex (`openssl rand -hex 32`) token the
 * length is a public protocol constant, not a credential, so this is
 * the standard recommendation for HMAC-style bearer auth in Node.
 *
 * Extracted into its own file so the server's HTTP layer can be tested
 * without dragging the full server.js init (resolver, node-pty dynamic
 * import, etc.) into the test.
 */
export function checkBearer(presented, expected) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  if (presented.length === 0 || expected.length === 0) return false;
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(presented), Buffer.from(expected));
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
