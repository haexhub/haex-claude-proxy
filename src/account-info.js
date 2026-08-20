/**
 * Reads account identity for the OAuth credential the proxy is already
 * using, so /setup/status can show *which* account is connected instead
 * of just a connected/not-connected boolean.
 *
 * `organizationUuid` and `subscriptionType` come straight out of the
 * already-on-disk .credentials.json (no network call). `emailAddress`
 * requires calling Anthropic's own oauth/profile endpoint with the
 * stored access token — the `user:profile` scope is already granted by
 * the standard `claude auth login --claudeai` flow this proxy drives,
 * so no new consent step is needed.
 *
 * Failures (expired token, network error, malformed file) degrade to
 * `null` fields rather than breaking /setup/status — account info is
 * a nice-to-have, not load-bearing for the proxy's actual job.
 */
import fsp from "node:fs/promises";
import path from "node:path";

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * @param {object} [opts]
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {number} [opts.cacheTtlMs]
 * @param {() => number} [opts.now]
 */
export function createAccountInfoReader({
  fetchImpl = fetch,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  now = () => Date.now(),
} = {}) {
  let cache = null; // { at, home, info }

  async function fetchEmail(accessToken) {
    const res = await fetchImpl(PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`oauth/profile responded ${res.status}`);
    }
    const profile = await res.json();
    return profile?.account?.email ?? null;
  }

  return {
    /**
     * @param {string} credentialsHome same HOME the FileResolver reads from
     * @returns {Promise<{organizationUuid: string|null, subscriptionType: string|null, emailAddress: string|null} | null>}
     */
    async get(credentialsHome) {
      if (cache && cache.home === credentialsHome && now() - cache.at < cacheTtlMs) {
        return cache.info;
      }

      let creds;
      try {
        const raw = await fsp.readFile(
          path.join(credentialsHome, ".claude", ".credentials.json"),
          "utf8",
        );
        creds = JSON.parse(raw);
      } catch {
        return null;
      }

      const info = {
        organizationUuid: creds.organizationUuid ?? null,
        subscriptionType: creds.claudeAiOauth?.subscriptionType ?? null,
        emailAddress: null,
      };

      const accessToken = creds.claudeAiOauth?.accessToken;
      if (accessToken) {
        try {
          info.emailAddress = await fetchEmail(accessToken);
        } catch {
          // Best-effort — local fields are still useful without it.
        }
      }

      cache = { at: now(), home: credentialsHome, info };
      return info;
    },
  };
}
