/**
 * Serializes async work that shares a credential HOME.
 *
 * The `claude` CLI subprocess writes refreshed OAuth tokens directly back
 * into its $HOME/.claude/.credentials.json with no locking of its own.
 * Confirmed by direct repro: two concurrent `claude` invocations sharing one
 * HOME, racing to refresh the same expired access token, corrupt that file
 * -- Anthropic rotates the refresh token on use, so the second invocation's
 * refresh attempt (using the now-stale token) fails, and the CLI's failure
 * path wipes accessToken/refreshToken to "" in the shared file, clobbering
 * the FIRST invocation's good write even though it ran first (last writer
 * wins, and the failing writer wrote last).
 *
 * A single human only ever runs one `claude` process against their own
 * $HOME at a time. The proxy is what introduces concurrent access to a
 * shared credential, so it owns serializing around that, not the CLI.
 */

import fsp from "node:fs/promises";
import path from "node:path";

const tails = new Map();

/**
 * Resolves with a `release()` function once it's the caller's turn for
 * `home`. The caller MUST call the returned function exactly once when its
 * critical section is done (subprocess closed + any writeback finished) so
 * the next queued caller for the same `home` can proceed. Callers for
 * different `home` values never block each other.
 *
 * @param {string} home
 * @returns {Promise<() => void>}
 */
export function acquireHomeLock(home) {
  const prevTail = tails.get(home) ?? Promise.resolve();
  let release;
  const myDone = new Promise((resolve) => {
    release = resolve;
  });
  tails.set(
    home,
    prevTail.then(() => myDone).catch(() => {}),
  );
  return prevTail.then(() => release);
}

// The corruption race above only fires when the CLI actually refreshes the
// access token, which it only does once that token is expired (or close to
// it). Most invocations just read a still-valid token -- concurrent reads
// are harmless. So: skip the lock (and the throughput hit that comes with
// it) whenever `home`'s access token has enough life left that the
// invocation we're about to spawn won't trigger a refresh; fall back to
// full serialization only in the window where it actually could.
const DEFAULT_FRESHNESS_MARGIN_MS = 15 * 60 * 1000;

/**
 * @param {string} home
 * @param {{ marginMs?: number, now?: () => number }} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAccessTokenFresh(home, opts = {}) {
  const marginMs = opts.marginMs ?? DEFAULT_FRESHNESS_MARGIN_MS;
  const now = opts.now ?? (() => Date.now());
  let raw;
  try {
    raw = await fsp.readFile(path.join(home, ".claude", ".credentials.json"), "utf8");
  } catch {
    return false;
  }
  let expiresAt;
  try {
    expiresAt = JSON.parse(raw)?.claudeAiOauth?.expiresAt;
  } catch {
    return false;
  }
  // Fail closed (serialize) on anything we can't confidently read as "well
  // clear of expiry" -- a wrong "fresh" guess risks the credential
  // corruption this module exists to prevent.
  if (typeof expiresAt !== "number") return false;
  return expiresAt - now() > marginMs;
}

/**
 * Same contract as {@link acquireHomeLock}, except the returned release is a
 * no-op (and callers never actually queue behind each other) when `home`'s
 * token is fresh per {@link isAccessTokenFresh}.
 *
 * @param {string} home
 * @param {{ marginMs?: number, now?: () => number }} [opts]
 * @returns {Promise<() => void>}
 */
export async function acquireHomeLockIfStale(home, opts = {}) {
  if (await isAccessTokenFresh(home, opts)) return () => {};
  return acquireHomeLock(home);
}
