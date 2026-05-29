/**
 * Web-driven `claude auth login --claudeai` flow.
 *
 * Wraps the interactive CLI in a state machine that an HTTP handler can
 * drive: start the flow → expose the OAuth URL → accept the code the
 * user copied off `platform.claude.com/oauth/code/callback` → wait for
 * the spawned `claude` to write `~/.claude/.credentials.json`.
 *
 * The CLI is a TUI — readline-style code prompt won't fire unless stdin
 * is a real PTY. `child_process.spawn` with piped stdio doesn't satisfy
 * that, so we use `node-pty` (loaded as an optional dep at runtime).
 * Tests inject a fake `spawnPty` and exercise the state machine without
 * touching the real CLI.
 *
 *   IDLE ──start()────────► AWAITING_URL ──URL parsed────► AWAITING_CODE
 *     ▲                          │                              │
 *     │                          │ CLI exits / timeout          │ submitCode(c)
 *     │                          ▼                              ▼
 *     └────────reset()────── ERROR ◄──CLI exits non-zero── FINISHING
 *                                                                │
 *                                                                │ credentials.json appears
 *                                                                ▼
 *                                                              DONE
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export const States = Object.freeze({
  IDLE: "idle",
  AWAITING_URL: "awaiting-url",
  AWAITING_CODE: "awaiting-code",
  FINISHING: "finishing",
  DONE: "done",
  ERROR: "error",
});

// The CLI's standard "If the browser didn't open, visit: <url>" line.
// We scan stdout for this and surface the URL. Whitespace-tolerant
// because the CLI sometimes wraps long lines.
const URL_LINE_RE =
  /If the browser didn't open, visit:\s*(https:\/\/claude\.com\/cai\/oauth\/authorize\?[^\s]+)/i;

// Cap on how much stdout we'll buffer waiting for the URL. The line is
// always short (< 1 KB) and emitted within the first half-second; this
// prevents an OOM if the CLI ever decided to go chatty.
const STDOUT_BUFFER_CAP = 64 * 1024;

/**
 * Build a setup controller. State lives on the returned object — caller
 * holds at most one of these per process (singleton enforced at the
 * server layer).
 *
 * @param {object} deps
 * @param {(cmd: string, args: string[], opts: object) => any} deps.spawnPty
 *        A node-pty-shape factory: returns an object with `.onData(cb)`,
 *        `.onExit(cb)`, `.write(s)`, `.kill()`, `.pid`. Production code
 *        passes `pty.spawn`; tests pass a controllable fake.
 * @param {string} deps.credentialsHome
 *        Absolute path. `claude auth login` is spawned with HOME pointed
 *        here, so the resulting `.claude/.credentials.json` lands at
 *        `{credentialsHome}/.claude/.credentials.json` — same location
 *        the FileResolver reads from at request time.
 * @param {string} [deps.claudeBin]  Default "claude".
 * @param {number} [deps.timeoutMs]  Max time from start() to DONE.
 *                                    Default 10 minutes; exceeding it
 *                                    kills the subprocess and transitions
 *                                    to ERROR.
 * @param {() => Date} [deps.now]    For deterministic timestamps in tests.
 */
export function createSetupController({
  spawnPty,
  credentialsHome,
  claudeBin = "claude",
  timeoutMs = 10 * 60 * 1000,
  now = () => new Date(),
}) {
  if (typeof spawnPty !== "function") {
    throw new Error("spawnPty function required");
  }
  if (!credentialsHome) {
    throw new Error("credentialsHome required");
  }

  let state = States.IDLE;
  let oauthUrl = null;
  let errorMessage = null;
  let startedAt = null;
  let proc = null;
  let stdoutBuf = "";
  let urlResolve = null;
  let urlReject = null;
  let urlPromise = null;
  let finishResolve = null;
  let finishReject = null;
  let finishPromise = null;
  let timeoutHandle = null;

  function snapshot() {
    return {
      state,
      oauthUrl,
      errorMessage,
      startedAt: startedAt ? startedAt.toISOString() : null,
    };
  }

  function clearTimers() {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
  }

  function transitionToError(message) {
    errorMessage = message;
    state = States.ERROR;
    if (urlReject) {
      urlReject(new Error(message));
      urlResolve = urlReject = null;
    }
    if (finishReject) {
      finishReject(new Error(message));
      finishResolve = finishReject = null;
    }
    clearTimers();
    if (proc) {
      try { proc.kill(); } catch { /* best-effort */ }
      proc = null;
    }
  }

  function handlePtyData(chunk) {
    if (stdoutBuf.length + chunk.length > STDOUT_BUFFER_CAP) {
      // Truncate from the front to keep recent output. We only need
      // the URL match, which appears once near the top.
      stdoutBuf = (stdoutBuf + chunk).slice(-STDOUT_BUFFER_CAP);
    } else {
      stdoutBuf += chunk;
    }

    if (state === States.AWAITING_URL) {
      const match = stdoutBuf.match(URL_LINE_RE);
      if (match) {
        oauthUrl = match[1];
        state = States.AWAITING_CODE;
        if (urlResolve) {
          urlResolve(oauthUrl);
          urlResolve = urlReject = null;
        }
      }
    }
  }

  async function handlePtyExit({ exitCode }) {
    clearTimers();
    proc = null;
    // Don't overwrite a prior ERROR. Common race: transitionToError
    // (timeout / start-time failure) already killed the subprocess,
    // whose exit handler now fires with exitCode=-1 — replacing the
    // helpful "timed out" message with "exited with code -1" would
    // confuse the operator.
    if (state === States.ERROR) {
      return;
    }
    if (exitCode === 0) {
      // Credentials should be on disk now. Verify.
      const credPath = path.join(credentialsHome, ".claude", ".credentials.json");
      try {
        await fsp.access(credPath);
        state = States.DONE;
        if (finishResolve) {
          finishResolve({ credentialsPath: credPath });
          finishResolve = finishReject = null;
        }
      } catch {
        transitionToError(
          "claude CLI exited 0 but credentials.json was not written",
        );
      }
      return;
    }
    transitionToError(
      `claude CLI exited with code ${exitCode}; recent output: ${stdoutBuf.slice(-512).trim()}`,
    );
  }

  return {
    snapshot,

    /**
     * Returns true if a credentials file already exists at the configured
     * HOME — handler uses this to short-circuit the UI ("you're already
     * logged in, want to re-link?").
     */
    async credentialsExist() {
      try {
        await fsp.access(path.join(credentialsHome, ".claude", ".credentials.json"));
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Start the flow. Spawns `claude auth login --claudeai` under a PTY,
     * resolves with the OAuth URL once parsed from stdout.
     *
     * Idempotent in IDLE / DONE / ERROR: kicks off a fresh flow.
     * In AWAITING_URL: returns the in-progress URL promise.
     * In AWAITING_CODE / FINISHING: rejects — caller must reset() first.
     */
    async start() {
      if (state === States.AWAITING_URL && urlPromise) {
        return urlPromise;
      }
      if (state === States.AWAITING_CODE) {
        // Already have the URL, just return it.
        return oauthUrl;
      }
      if (state === States.FINISHING) {
        throw new Error(
          "a code is being processed; call reset() to start over",
        );
      }

      // (Re-)initialize.
      state = States.AWAITING_URL;
      oauthUrl = null;
      errorMessage = null;
      stdoutBuf = "";
      startedAt = now();

      // Set up promises FIRST so transitionToError can reject them if
      // anything below throws. Without this an mkdir/spawn failure
      // would leave state=AWAITING_URL with no urlPromise — the next
      // start() call would spawn a second subprocess and orphan the
      // first failure.
      urlPromise = new Promise((resolve, reject) => {
        urlResolve = resolve;
        urlReject = reject;
      });
      finishPromise = new Promise((resolve, reject) => {
        finishResolve = resolve;
        finishReject = reject;
      });
      finishPromise.catch(() => {});

      // Ensure HOME exists. `claude` will create .claude/ inside, but
      // bombs out if HOME itself is missing. Done sync so callers can
      // emit data IMMEDIATELY after start() returns without missing
      // the onData wire-up that follows.
      try {
        fs.mkdirSync(credentialsHome, { recursive: true });
      } catch (e) {
        transitionToError(`failed to mkdir ${credentialsHome}: ${e.message}`);
        return urlPromise;
      }

      try {
        proc = spawnPty(claudeBin, ["auth", "login", "--claudeai"], {
          name: "xterm-256color",
          cols: 100,
          rows: 30,
          env: { ...process.env, HOME: credentialsHome },
        });
      } catch (e) {
        transitionToError(`failed to spawn claude CLI: ${e.message}`);
        return urlPromise;
      }

      proc.onData((chunk) => handlePtyData(String(chunk)));
      proc.onExit((evt) => {
        // node-pty's onExit fires with {exitCode, signal}; some shims
        // pass just the code as a number — normalize.
        const exitCode =
          typeof evt === "number"
            ? evt
            : typeof evt?.exitCode === "number"
              ? evt.exitCode
              : -1;
        handlePtyExit({ exitCode });
      });

      timeoutHandle = setTimeout(() => {
        transitionToError(`setup-login timed out after ${timeoutMs}ms`);
      }, timeoutMs);

      return urlPromise;
    },

    /**
     * Feed the OAuth code (copied from platform.claude.com) into the
     * CLI's stdin. Resolves once `claude` exits 0 AND credentials.json
     * is on disk. Rejects on CLI failure / timeout.
     */
    async submitCode(code) {
      if (state !== States.AWAITING_CODE) {
        throw new Error(
          `cannot submit code in state '${state}' — start() the flow first`,
        );
      }
      if (typeof code !== "string" || !code.trim()) {
        throw new Error("code must be a non-empty string");
      }
      state = States.FINISHING;
      // The CLI's readline prompt expects the pasted code followed by a
      // newline. node-pty doesn't auto-append.
      proc.write(`${code.trim()}\r`);
      return finishPromise;
    },

    /**
     * Force-reset to IDLE. Kills the subprocess if any. Used when the
     * user wants to start over (e.g. they pasted a bad code and the CLI
     * is stuck in error state) and on shutdown.
     */
    reset() {
      clearTimers();
      if (proc) {
        try { proc.kill(); } catch { /* best-effort */ }
        proc = null;
      }
      if (urlReject) {
        urlReject(new Error("reset() called"));
      }
      if (finishReject) {
        finishReject(new Error("reset() called"));
      }
      urlResolve = urlReject = null;
      finishResolve = finishReject = null;
      urlPromise = null;
      finishPromise = null;
      state = States.IDLE;
      oauthUrl = null;
      errorMessage = null;
      stdoutBuf = "";
      startedAt = null;
    },
  };
}

// Exported for tests.
export const _internal = {
  URL_LINE_RE,
  STDOUT_BUFFER_CAP,
};
