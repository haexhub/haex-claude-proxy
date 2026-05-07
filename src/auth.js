/**
 * Multi-tenant session-token resolver.
 *
 * Phase 7: hermes workers spawned by specifyr forward an
 * `ANTHROPIC_API_KEY=<sessionToken>` (minted by specifyr's
 * runner_sessions table). The proxy reads that token from the inbound
 * request, looks it up against the same Postgres, and resolves it to
 * an `(ownerKind, ownerId)` pair. The `claude` CLI subprocess is then
 * spawned with `HOME=/credentials/<ownerKind>/<ownerId>` so it reads
 * the matching `.claude/.credentials.json`.
 *
 * One container, many subprocesses, isolated only by HOME.
 *
 * When DATABASE_URL is unset (Phase 6 pre-rollout, dev workstations),
 * the resolver returns null for every token and the caller falls back
 * to the historical single-tenant `/home/node/.claude` mount.
 */

import path from "node:path";

const TOKEN_REGEX = /^[0-9a-f]{64}$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pull a session token out of the inbound request headers. Both the
 * Anthropic SDK (`x-api-key`) and the OpenAI SDK (`authorization:
 * Bearer …`) shapes are supported so we don't have to coordinate which
 * client a worker uses.
 *
 * Returns null when no token-shaped value is present.
 */
export function extractSessionToken(req) {
  const auth = req.headers?.["authorization"];
  if (typeof auth === "string") {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim() || null;
  }
  const apiKey = req.headers?.["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) {
    return apiKey.trim();
  }
  return null;
}

/**
 * Returns true iff the token has the shape we mint in specifyr
 * (32 random bytes hex-encoded). This is a cheap pre-filter so we
 * don't hit the DB for the historical hermes "sk-ant-api03-…" placeholder
 * key (still injected when no per-user credential is configured).
 */
export function looksLikeSessionToken(token) {
  return typeof token === "string" && TOKEN_REGEX.test(token);
}

/**
 * Builds an async lookup function that takes a token and returns the
 * resolved owner. Returns null on miss / expired / revoked.
 *
 * Pool is injected so tests can swap in a fake `query` impl. In
 * production server.js wires this to a long-lived pg.Pool.
 */
export function createDbLookup(pool) {
  return async function lookupSession(token) {
    if (!looksLikeSessionToken(token)) return null;
    const result = await pool.query(
      `SELECT user_id, owner_kind, owner_id, expires_at, revoked_at
       FROM runner_sessions
       WHERE token = $1
       LIMIT 1`,
      [token],
    );
    const row = result.rows?.[0];
    if (!row) return null;
    if (row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= Date.now()) return null;
    return {
      userId: row.user_id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
    };
  };
}

/**
 * Maps an (ownerKind, ownerId) pair to the directory the spawned
 * claude CLI should treat as $HOME. The CLI reads
 * `$HOME/.claude/.credentials.json`; layout under credentialsRoot:
 *
 *   <root>/user/<userId>/.claude/.credentials.json
 *   <root>/org/<orgId>/.claude/.credentials.json
 *
 * Validates inputs because they go straight into a path — anything
 * untrusted in there would be a path-traversal bug.
 */
export function homeForOwner(credentialsRoot, ownerKind, ownerId) {
  if (ownerKind !== "user" && ownerKind !== "org") {
    throw new Error(`invalid ownerKind: ${ownerKind}`);
  }
  if (!UUID_REGEX.test(ownerId)) {
    throw new Error(`invalid ownerId (not a uuid): ${ownerId}`);
  }
  return path.join(credentialsRoot, ownerKind, ownerId);
}
