/**
 * Multi-tenant session-token + credentials resolver.
 *
 * hermes workers spawned by specifyr forward an
 * `ANTHROPIC_API_KEY=<sessionToken>` (minted by specifyr's
 * runner_sessions table). This module:
 *
 *   1. extracts the token from the inbound request,
 *   2. resolves it via createDbLookup → (ownerKind, ownerId),
 *   3. loads the encrypted oauth credential row for that owner via
 *      createCredentialsStore. Both load() and writeback() set
 *      `app.current_owner_kind/id` via `set_config(..., true)` inside
 *      a transaction so Postgres Row-Level-Security policies on the
 *      `llm_credentials` table only expose rows the resolved owner is
 *      authorised for. Without those SETs the queries see nothing
 *      under the `haex_claude_proxy` DB role.
 *
 * The caller stages the decrypted plaintext into an ephemeral HOME
 * (tmpfs, per-request) and points the `claude` subprocess at it. After
 * the subprocess exits, writeback() persists the refreshed blob.
 *
 * No bind-mounted credentials dir, no plaintext on disk past process
 * exit. When DATABASE_URL or SPECIFYR_SECRET_KEY is unset the proxy
 * returns 503 for every request — there is no host-fallback mode.
 */

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
      `SELECT user_id, owner_kind, owner_id, credential_id, expires_at, revoked_at
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
      credentialId: row.credential_id ?? null,
    };
  };
}

/**
 * Lädt die in DB verschlüsselt persistierten Credentials für eine Session
 * und liefert eine diskriminierte Variante zurück:
 *
 *   { mode: 'oauth_claude', id, plaintext, expiresAt }
 *   { mode: 'api_key',     id, provider, apiKey, baseUrl }
 *
 * Aufrufkonventionen:
 *   - `credentialId` gesetzt → direktes Lookup auf llm_credentials.id.
 *     Diese Spalte trägt die Session seit Session A. Schließt ab, dass
 *     ein Owner mit mehreren Credentials (z.B. Anthropic api_key UND
 *     Anthropic oauth_claude) gezielt auf eine bestimmte routet wird.
 *   - Legacy: ohne `credentialId` fallen wir auf das alte Verhalten
 *     zurück (latest enabled oauth_claude/anthropic für den Owner). So
 *     funktionieren alte Tokens aus runner_sessions-Rows weiter, die vor
 *     dem Schema-Bump gemintet wurden.
 *
 * RLS-aware: vor dem SELECT setzen wir `app.current_owner_kind/id` via
 * set_config(..., true) in einer Transaction, weil die llm_credentials-
 * Policy für die haex_claude_proxy-DB-Rolle auf diese Settings filtert.
 * Ohne SET findet der Query NICHTS, selbst wenn die Row existiert.
 *
 * Returns null, wenn kein passendes Credential auffindbar/usable ist.
 */
export function createCredentialsStore(pool, decrypt) {
  return {
    async load(ownerKind, ownerId, credentialId = null) {
      if (ownerKind !== "user" && ownerKind !== "org") {
        throw new Error(`invalid ownerKind: ${ownerKind}`);
      }
      if (!UUID_REGEX.test(ownerId)) {
        throw new Error(`invalid ownerId (not a uuid): ${ownerId}`);
      }
      if (credentialId !== null && !UUID_REGEX.test(credentialId)) {
        throw new Error(`invalid credentialId (not a uuid): ${credentialId}`);
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.current_owner_kind', $1, true)",
          [ownerKind],
        );
        await client.query(
          "SELECT set_config('app.current_owner_id', $1, true)",
          [ownerId],
        );
        let res;
        if (credentialId) {
          res = await client.query(
            `SELECT id, provider, mode, base_url, enabled, oauth_status,
                    api_key_iv, api_key_tag, api_key_data,
                    oauth_credentials_iv, oauth_credentials_tag,
                    oauth_credentials_data, oauth_expires_at
             FROM llm_credentials
             WHERE id = $1
             LIMIT 1`,
            [credentialId],
          );
        } else {
          res = await client.query(
            `SELECT id, provider, mode, base_url, enabled, oauth_status,
                    api_key_iv, api_key_tag, api_key_data,
                    oauth_credentials_iv, oauth_credentials_tag,
                    oauth_credentials_data, oauth_expires_at
             FROM llm_credentials
             WHERE owner_kind = $1
               AND owner_id   = $2
               AND provider   = 'anthropic'
               AND mode       = 'oauth_claude'
               AND enabled    = true
               AND oauth_status = 'authorized'
               AND oauth_credentials_data IS NOT NULL
             ORDER BY updated_at DESC
             LIMIT 1`,
            [ownerKind, ownerId],
          );
        }
        await client.query("COMMIT");
        const row = res.rows[0];
        if (!row) return null;
        if (row.enabled === false) return null;
        if (row.mode === "oauth_claude") {
          if (row.oauth_status !== "authorized") return null;
          if (!row.oauth_credentials_data) return null;
          const plaintext = decrypt({
            iv: row.oauth_credentials_iv,
            tag: row.oauth_credentials_tag,
            data: row.oauth_credentials_data,
          });
          return {
            mode: "oauth_claude",
            id: row.id,
            plaintext,
            expiresAt: row.oauth_expires_at,
          };
        }
        if (row.mode === "api_key") {
          if (!row.api_key_data) return null;
          const apiKey = decrypt({
            iv: row.api_key_iv,
            tag: row.api_key_tag,
            data: row.api_key_data,
          });
          return {
            mode: "api_key",
            id: row.id,
            provider: row.provider,
            apiKey,
            baseUrl: row.base_url ?? null,
          };
        }
        return null;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    /**
     * Schreibt den (claude-refreshten) Plaintext-Token zurück. Identische
     * RLS-Mechanik wie load(): SET LOCAL setzt den Owner-Kontext, die
     * Policy lässt nur UPDATEs auf eigenen Rows zu. Spalten-GRANT in
     * Ansible erlaubt UPDATE nur auf die fünf hier modifizierten Spalten.
     */
    async writeback(credId, ownerKind, ownerId, encrypted, expiresAt) {
      if (ownerKind !== "user" && ownerKind !== "org") {
        throw new Error(`invalid ownerKind: ${ownerKind}`);
      }
      if (!UUID_REGEX.test(ownerId) || !UUID_REGEX.test(credId)) {
        throw new Error("invalid owner/credential UUID");
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.current_owner_kind', $1, true)",
          [ownerKind],
        );
        await client.query(
          "SELECT set_config('app.current_owner_id', $1, true)",
          [ownerId],
        );
        await client.query(
          `UPDATE llm_credentials
           SET oauth_credentials_iv   = $2,
               oauth_credentials_tag  = $3,
               oauth_credentials_data = $4,
               oauth_expires_at       = $5,
               updated_at             = NOW()
           WHERE id = $1`,
          [credId, encrypted.iv, encrypted.tag, encrypted.data, expiresAt],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

/**
 * Parst expiresAt aus dem credentials.json-Plaintext (gleiche Logik wie
 * specifyr's readCredentialsState). Toleriert beide Shapes:
 *   - top-level `expiresAt` (numeric ms)
 *   - nested under `claudeAiOauth.expires_at` (ISO string)
 * Returns null wenn nichts Verwertbares gefunden wurde.
 */
export function parseExpiresAt(plaintext) {
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    return null;
  }
  const candidates = [];
  for (const v of Object.values(parsed)) {
    if (v && typeof v === "object") candidates.push(v);
  }
  candidates.push(parsed);
  for (const c of candidates) {
    const ms = typeof c.expiresAt === "number" ? c.expiresAt : undefined;
    if (ms) return new Date(ms);
    const iso = typeof c.expires_at === "string" ? c.expires_at : undefined;
    if (iso) {
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}
