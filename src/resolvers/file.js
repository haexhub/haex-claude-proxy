import path from "node:path";
import fs from "node:fs/promises";

/**
 * Single-user FileResolver. Reads OAuth credentials from a persistent
 * `$PROXY_CREDENTIALS_HOME/.claude/.credentials.json`. The directory
 * IS the home the spawned `claude` subprocess reads from — no per-
 * request copy, no tmpfs, no DB.
 *
 * Token refresh: the spawned claude writes the new blob back into the
 * same HOME, so there's nothing for writeback() to do. `persistent:
 * true` on the resolve result tells the server handler to skip the
 * post-spawn `fs.rm` step — wiping HOME would 503 the very next
 * request.
 *
 * Errors are returned from `resolve()`, not thrown from `create()`,
 * so the proxy boots and serves /healthz even when misconfigured.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} env
 * @returns {{
 *   name: "file",
 *   resolve(req): Promise<object>,
 *   writeback(ctx, refreshedPlaintext): Promise<void>
 * }}
 */
export function create(env) {
  const home = env.PROXY_CREDENTIALS_HOME;

  return {
    name: "file",

    async resolve(_req) {
      if (!home) {
        return {
          error: {
            status: 503,
            type: "configuration_error",
            message:
              "PROXY_CREDENTIALS_HOME is unset - point it at a directory containing .claude/.credentials.json",
          },
        };
      }
      try {
        await fs.access(path.join(home, ".claude", ".credentials.json"));
      } catch {
        return {
          error: {
            status: 503,
            type: "configuration_error",
            message:
              `credentials.json not found at ${home}/.claude/.credentials.json - run 'claude login' against this HOME first`,
          },
        };
      }
      return {
        mode: "oauth_claude",
        home,
        credId: "file",
        persistent: true,
      };
    },

    async writeback(_ctx, _refreshedPlaintext) {
      // The spawned claude wrote refreshed credentials directly into
      // HOME. Nothing to persist; it's already on disk.
    },
  };
}
