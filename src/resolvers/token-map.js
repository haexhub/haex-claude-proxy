import path from "node:path";
import fs from "node:fs/promises";

/**
 * Static `token -> home` map loaded once at boot from a JSON file.
 * Each token maps to one persistent HOME directory; the spawned
 * `claude` reads (and writes refreshed tokens to) that HOME
 * directly — no per-request staging, no cleanup, no DB.
 *
 * Map format:
 *
 *   {
 *     "<opaque-token-string>": { "home": "/path/to/.claude-parent" }
 *   }
 *
 * Tokens are opaque strings; the resolver doesn't enforce a shape.
 * Use long random values if the proxy is reachable from outside
 * trusted networks.
 *
 * Boot-time errors throw (missing/unparseable map). Per-request
 * errors come back as { error: { status, type, message } }.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @returns {Promise<{
 *   name: "token-map",
 *   resolve(req): Promise<object>,
 *   writeback(ctx, refreshedPlaintext): Promise<void>
 * }>}
 */
export async function create(env) {
  const mapPath = env.PROXY_TOKEN_MAP;
  if (!mapPath) {
    throw new Error(
      "PROXY_RESOLVER=token-map requires PROXY_TOKEN_MAP=/path/to/tokens.json",
    );
  }
  let parsed;
  try {
    const raw = await fs.readFile(mapPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`failed to load PROXY_TOKEN_MAP at ${mapPath}: ${e.message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      `PROXY_TOKEN_MAP must be a JSON object of { token: { home } } entries`,
    );
  }

  return {
    name: "token-map",

    async resolve(req) {
      const token = extractToken(req);
      if (!token) {
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "missing token (x-api-key or Authorization: Bearer ...)",
          },
        };
      }
      const entry = parsed[token];
      if (!entry?.home) {
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "unknown token",
          },
        };
      }
      try {
        await fs.access(path.join(entry.home, ".claude", ".credentials.json"));
      } catch {
        return {
          error: {
            status: 503,
            type: "configuration_error",
            message: `credentials.json not found at ${entry.home}/.claude/.credentials.json`,
          },
        };
      }
      return {
        mode: "oauth_claude",
        home: entry.home,
        credId: token,
        persistent: true,
      };
    },

    async writeback(_ctx, _refreshedPlaintext) {
      // Mapped HOMEs are persistent; the spawned claude wrote refreshed
      // credentials there directly. Nothing to do.
    },
  };
}

function extractToken(req) {
  const auth = req.headers?.["authorization"];
  if (typeof auth === "string") {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim() || null;
  }
  const apiKey = req.headers?.["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return null;
}
