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
