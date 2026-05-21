# Generic Resolver Refactor — Implementation Plan

> **Plan evolution (2026-05-21, mid-execution):** scope shifted from "Pg-resolver
> as a builtin" to **"Pg-resolver as a standalone plugin"** so the proxy core can
> be fully generic. Affected sections:
>
> - **Task 1.4 rewritten.** The pg-encrypted resolver no longer lives in this
>   repo. It moved to `haex-claude-proxy-resolver-pg` (sibling repo). The
>   dispatcher now treats any non-builtin `PROXY_RESOLVER` value as an NPM
>   module name and loads it via dynamic `import()`.
> - **Tasks 4.1 / 4.2 obsolete.** `src/auth.js`, `src/crypto.js`, and
>   `test/auth.test.js` were deleted (not moved into a subfolder). `pg` is
>   gone from `package.json` entirely (not made optional).
> - **Phase 2.3 smoke** subsumed by the smoke check at the end of Phase 1.5.
>
> The phase-by-phase text below is the original plan; the *commit history* on
> branch `refactor/generic-resolver` reflects the executed shape. See
> `CHANGELOG.md` for the final architecture summary.

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal (revised):** Make `haex-claude-proxy` a fully generic, plugin-driven proxy
core. Builtin resolvers (`file`, `token-map`) cover the single-user and
multi-token cases; the Specifyr Postgres + AES-GCM resolver ships separately as
`haex-claude-proxy-resolver-pg`.

**Architecture:** Extract the credential-resolution logic from `src/server.js` into a small interface (`Resolver.resolve(req) -> ResolverResult`). Ship two builtin implementations in the core (`FileResolver` (default) and `TokenMapResolver`); external implementations (e.g. `haex-claude-proxy-resolver-pg`) are NPM modules loaded via dynamic `import()`. Selection is driven by `PROXY_RESOLVER` env var; default is `file`. The proxy core ends up with zero runtime dependencies.

**Tech Stack:** Node.js ≥22 (ESM), built-in `node:test` for unit tests. No `pg` or crypto deps in core; those live in the plugin.

**Out of scope:** Hermes itself. New endpoints. Format-translation changes. Changes to `cli-format.js` / `bufferedThenSSE` / streaming behaviour.

**Compatibility constraint:** Existing Specifyr deploys keep working by installing the `haex-claude-proxy-resolver-pg` plugin and setting `PROXY_RESOLVER=haex-claude-proxy-resolver-pg`. The plugin's env-var surface (`DATABASE_URL`, `SPECIFYR_SECRET_KEY`, `CREDENTIALS_ROOT`) is identical to today's proxy.

---

## Phase 0 — Baseline & branch

### Task 0.1: Verify baseline tests pass

**Files:** none

**Step 1: Run all tests**

Run: `npm test`
Expected: all tests in `test/auth.test.js` and `test/format.test.js` pass. `test/integration.test.js` runs only with `CLAUDE_PROXY_E2E=1`; skip it for now.

**Step 2: Note the baseline**

Record the test count in `tmp/baseline-test-count.txt` so later phases can detect regression. Run:
```bash
npm test 2>&1 | tail -3 | tee tmp/baseline-test-count.txt
```

### Task 0.2: Create feature branch

**Step 1: Create branch**

```bash
git checkout -b refactor/generic-resolver
```

**Step 2: Confirm clean tree**

```bash
git status
```
Expected: "nothing to commit, working tree clean".

---

## Phase 1 — Extract Resolver interface (no behaviour change)

**Why this phase exists:** Move today's `resolveRequestContext` out of `server.js` without changing what it does. After Phase 1 the proxy behaves identically; the surface area is just reshaped to make Phase 2/3 simple.

### Task 1.1: Define the Resolver interface contract

**Files:**
- Create: `src/resolvers/types.md` (documentation only, not code)

**Step 1: Write the contract**

```markdown
# Resolver contract

A Resolver is `{ name: string, resolve(req): Promise<ResolverResult> }`.

`ResolverResult` is one of:

```js
// On error — handler turns this into an HTTP error response.
{ error: { status: number, type: string, message: string } }

// OAuth-claude path — handler stages a per-request tmpfs HOME with the
// plaintext credentials and spawns `claude --print`. After spawn exit,
// the handler calls `resolver.writeback(ctx, refreshedPlaintext)` if the
// resolver supports it.
{ mode: "oauth_claude", home: string, credId: string, ownerKind?: string, ownerId?: string }

// API-key passthrough — handler forwards the inbound request to the
// upstream API with the decrypted key. Stays in the core because every
// resolver implementation may want it.
{ mode: "api_key", credId: string, provider: string, apiKey: string, baseUrl?: string|null,
  ownerKind?: string, ownerId?: string }
```

Optional method: `writeback(ctx, refreshedPlaintext): Promise<void>` — called only
when the spawn refreshed the OAuth token. Resolvers that don't persist
credentials (e.g. `FileResolver` pointing at a writable home) can no-op.
```

**Step 2: Commit**

```bash
git add src/resolvers/types.md
git commit -m "docs: define resolver interface contract"
```

### Task 1.2: Failing test — interface dispatcher exists

**Files:**
- Create: `test/resolver-dispatch.test.js`

**Step 1: Write the failing test**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { createResolver } from "../src/resolvers/index.js";

test("createResolver throws on unknown PROXY_RESOLVER value", () => {
  assert.throws(() => createResolver({ PROXY_RESOLVER: "bogus" }), /unknown resolver/i);
});

test("createResolver returns a resolver with name=file by default", () => {
  const r = createResolver({ PROXY_RESOLVER: undefined, PROXY_CREDENTIALS_HOME: "/tmp" });
  assert.equal(r.name, "file");
  assert.equal(typeof r.resolve, "function");
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/resolver-dispatch.test.js`
Expected: FAIL — `Cannot find module '../src/resolvers/index.js'`.

### Task 1.3: Minimal dispatcher

**Files:**
- Create: `src/resolvers/index.js`

**Step 1: Implement**

```js
/**
 * Resolver dispatch. Picks the resolver implementation based on
 * `PROXY_RESOLVER` (default: 'file'). Each resolver is a thin module
 * that exports a `create(env)` factory; this dispatcher just routes.
 */
export function createResolver(env = process.env) {
  const kind = (env.PROXY_RESOLVER ?? "file").toLowerCase();
  switch (kind) {
    case "file":
      return require_dynamic("./file.js").create(env);
    case "token-map":
      return require_dynamic("./token-map.js").create(env);
    case "pg-encrypted":
      return require_dynamic("./pg-encrypted.js").create(env);
    default:
      throw new Error(`unknown resolver '${kind}' — expected file|token-map|pg-encrypted`);
  }
}

// Lazy import so optional deps (pg) are only loaded when the
// corresponding resolver is requested.
function require_dynamic(rel) {
  // Synchronous CJS require under ESM via createRequire — avoids top-level
  // await in this hot path.
  return globalThis.__resolverRequireCache?.[rel]
    ?? (globalThis.__resolverRequireCache = {
        ...(globalThis.__resolverRequireCache ?? {}),
        [rel]: import_sync(rel),
      })[rel];
}

function import_sync(rel) {
  // Use createRequire from node:module — synchronous, supports peer-loading
  // optional deps without breaking ESM consumers.
  const { createRequire } = globalThis.__createRequire ?? (globalThis.__createRequire = (() => {
    return (await import("node:module")).createRequire;
  }));
  // …
}
```

**Note for the implementer:** that `require_dynamic` sketch is overkill. Use plain dynamic `await import()` at the call site instead. Replace the body with:

```js
export async function createResolver(env = process.env) {
  const kind = (env.PROXY_RESOLVER ?? "file").toLowerCase();
  switch (kind) {
    case "file":         return (await import("./file.js")).create(env);
    case "token-map":    return (await import("./token-map.js")).create(env);
    case "pg-encrypted": return (await import("./pg-encrypted.js")).create(env);
    default:
      throw new Error(`unknown resolver '${kind}' — expected file|token-map|pg-encrypted`);
  }
}
```

…and adjust the test to `await createResolver(...)`. The async signature is the right shape: it lets each resolver do its own startup work (read a JSON map, ping the DB) without forcing the dispatcher to know.

**Step 2: Update the test to await**

Replace `createResolver({...})` with `await createResolver({...})` and mark the test bodies `async`. Re-run:
```bash
node --test test/resolver-dispatch.test.js
```
Expected: first test passes (unknown resolver throws). Second test fails because `./file.js` doesn't exist yet — that's fine, we'll fix it in Task 1.4.

**Step 3: Commit**

```bash
git add src/resolvers/index.js test/resolver-dispatch.test.js
git commit -m "feat(resolvers): add dispatcher with lazy resolver loading"
```

### Task 1.4: Move Pg+crypto code into `pg-encrypted` resolver

**Files:**
- Create: `src/resolvers/pg-encrypted.js`
- Move from `src/auth.js`: everything (the file becomes thin — see Task 1.5)
- Move from `src/crypto.js`: keep file in place, import from new location

**Step 1: Create `src/resolvers/pg-encrypted.js`**

This file owns:
1. The `pg.Pool` construction (lazy — only if `DATABASE_URL` is set; the resolver throws on `create()` if not, since this resolver requires DB).
2. `createDbLookup`, `createCredentialsStore` — re-exported from the existing `src/auth.js` for now (Task 1.5 will move them in).
3. The `resolveRequestContext`-equivalent function, named `resolve(req)` here.
4. A `writeback(ctx, refreshedPlaintext)` method that encrypts + persists, mirroring `persistRefreshedTokenAndCleanup` minus the filesystem cleanup (that stays in the handler — it's not resolver business).

Skeleton:

```js
import path from "node:path";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";

import pg from "pg";

import {
  createCredentialsStore,
  createDbLookup,
  extractSessionToken,
  looksLikeSessionToken,
  parseExpiresAt,
} from "../auth.js";
import { decrypt, encrypt } from "../crypto.js";

export function create(env) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "PROXY_RESOLVER=pg-encrypted requires DATABASE_URL — point it at Specifyr's Postgres",
    );
  }
  const credsRoot = env.CREDENTIALS_ROOT ?? "/run/credentials";

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  const lookupSession = createDbLookup(pool);
  const credentialsStore = createCredentialsStore(pool, decrypt);

  return {
    name: "pg-encrypted",

    async resolve(req) {
      const token = extractSessionToken(req);
      if (!token || !looksLikeSessionToken(token)) {
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message:
              "missing or malformed session token — inject ANTHROPIC_API_KEY=<runner-session>",
          },
        };
      }
      const session = await lookupSession(token);
      if (!session) {
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "session token not recognised — unknown, expired, or revoked",
          },
        };
      }
      let cred;
      try {
        cred = await credentialsStore.load(
          session.ownerKind, session.ownerId, session.credentialId,
        );
      } catch (e) {
        return { error: { status: 500, type: "api_error", message: `credentials lookup failed: ${e.message}` } };
      }
      if (!cred) {
        return {
          error: {
            status: 401,
            type: "authentication_error",
            message: "no usable credential for this session",
          },
        };
      }
      if (cred.mode === "api_key") {
        return {
          mode: "api_key",
          credId: cred.id,
          provider: cred.provider,
          apiKey: cred.apiKey,
          baseUrl: cred.baseUrl,
          ownerKind: session.ownerKind,
          ownerId: session.ownerId,
        };
      }
      // oauth_claude — stage per-request tmpfs HOME.
      const spawnId = randomBytes(12).toString("hex");
      const home = path.join(credsRoot, spawnId);
      try {
        await fs.mkdir(path.join(home, ".claude"), { recursive: true, mode: 0o700 });
        await fs.writeFile(
          path.join(home, ".claude", ".credentials.json"),
          cred.plaintext,
          { mode: 0o600 },
        );
      } catch (e) {
        return { error: { status: 500, type: "api_error", message: `failed to stage credentials: ${e.message}` } };
      }
      return {
        mode: "oauth_claude",
        home,
        credId: cred.id,
        ownerKind: session.ownerKind,
        ownerId: session.ownerId,
        // Internal: original plaintext for refresh-detection. Handler
        // passes this back via writeback(). Kept on the result so the
        // resolver itself stays stateless across requests.
        _originalPlaintext: cred.plaintext,
      };
    },

    async writeback(ctx, refreshedPlaintext) {
      if (ctx.mode !== "oauth_claude") return;
      if (!refreshedPlaintext || refreshedPlaintext === ctx._originalPlaintext) return;
      const expiresAt = parseExpiresAt(refreshedPlaintext);
      const encrypted = encrypt(refreshedPlaintext);
      await credentialsStore.writeback(
        ctx.credId, ctx.ownerKind, ctx.ownerId, encrypted, expiresAt,
      );
    },
  };
}
```

**Step 2: Run existing auth tests — must still pass**

```bash
node --test test/auth.test.js
```
Expected: all tests pass — we didn't change `auth.js` or `crypto.js`, only added a new file that imports from them.

**Step 3: Commit**

```bash
git add src/resolvers/pg-encrypted.js
git commit -m "feat(resolvers): add pg-encrypted resolver wrapping existing auth+crypto"
```

### Task 1.5: Wire the dispatcher into `server.js` (still pg-only behaviour-wise)

**Files:**
- Modify: `src/server.js`

**Step 1: Replace `resolveRequestContext` call sites**

Find every `await resolveRequestContext(req)` (currently two: in `handleMessages` and `handleChatCompletions`) and replace with `await resolver.resolve(req)`.

Add at the top of `server.js`, after the imports:

```js
import { createResolver } from "./resolvers/index.js";

// Eager-load resolver at boot so config errors surface immediately
// (rather than on first request). The dispatcher's switch is sync;
// each resolver's `create()` is async if it needs to be.
const resolver = await createResolver(process.env);
console.log(`[haex-claude-proxy] resolver=${resolver.name}`);
```

Delete the old `resolveRequestContext` function. Delete the inline `pool` and `credentialsStore` constants — those are now inside the pg-encrypted resolver. Also delete the now-unused `lookupSession` const.

**Step 2: Replace `persistRefreshedTokenAndCleanup` with resolver writeback**

The handler still needs to:
1. After spawn exit: read back the credentials file (refresh detection).
2. Call `resolver.writeback?.(ctx, refreshedPlaintext)` (optional method — token-map / file resolvers can no-op).
3. `rm -rf` the tmpfs home dir.

Replace the old function with:

```js
async function persistRefreshedTokenAndCleanup(ctx) {
  const credPath = path.join(ctx.home, ".claude", ".credentials.json");
  let refreshed = null;
  try {
    refreshed = await fsp.readFile(credPath, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") console.error("[proxy] refresh-readback failed:", e.message);
  }
  if (refreshed && resolver.writeback) {
    try {
      await resolver.writeback(ctx, refreshed);
    } catch (e) {
      console.error("[proxy] resolver writeback failed:", e.message);
    }
  }
  await fsp.rm(ctx.home, { recursive: true, force: true }).catch(() => {});
}
```

**Step 3: Smoke-test boot**

With `PROXY_RESOLVER=pg-encrypted DATABASE_URL=postgres://... SPECIFYR_SECRET_KEY=...` set in env (or a dummy `DATABASE_URL` that just needs to not be empty), run:

```bash
node src/server.js &
sleep 1
curl -s http://localhost:8080/healthz
kill %1
```

Expected: `{"ok":true,"claudeVersion":"..."}` — same as before the refactor.

**Step 4: Run full test suite**

```bash
npm test
```
Expected: all green; no regression.

**Step 5: Commit**

```bash
git add src/server.js
git commit -m "refactor: route credential resolution through pluggable resolver"
```

---

## Phase 2 — FileResolver (the single-user default)

**Why this phase exists:** This is the resolver Hermes will use. Single-user, zero DB, zero crypto-key.

### Task 2.1: Failing test — FileResolver with PROXY_CREDENTIALS_HOME

**Files:**
- Create: `test/resolver-file.test.js`

**Step 1: Write tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { create } from "../src/resolvers/file.js";

async function makeHome(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-file-"));
  await fs.mkdir(path.join(dir, ".claude"), { recursive: true });
  await fs.writeFile(path.join(dir, ".claude", ".credentials.json"), contents, "utf8");
  return dir;
}

test("file resolver: returns oauth_claude with HOME pointing at PROXY_CREDENTIALS_HOME", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const resolver = create({ PROXY_CREDENTIALS_HOME: home });
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.mode, "oauth_claude");
  assert.equal(result.home, home);
  assert.equal(result.credId, "file");
  assert.equal(resolver.name, "file");
});

test("file resolver: errors with 503 when PROXY_CREDENTIALS_HOME is unset", async () => {
  const resolver = create({});
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.error?.status, 503);
  assert.match(result.error.message, /PROXY_CREDENTIALS_HOME/);
});

test("file resolver: errors with 503 when .credentials.json missing in HOME", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-empty-"));
  const resolver = create({ PROXY_CREDENTIALS_HOME: empty });
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.error?.status, 503);
  assert.match(result.error.message, /credentials\.json/);
});

test("file resolver: writeback is a no-op (home is the persistent store)", async () => {
  const home = await makeHome(JSON.stringify({ claudeAiOauth: { access_token: "x" } }));
  const resolver = create({ PROXY_CREDENTIALS_HOME: home });
  // No-throw is the contract.
  await resolver.writeback({ mode: "oauth_claude", home }, "new contents");
  // The handler will rm -rf ctx.home AFTER writeback. Since FileResolver
  // uses HOME directly (no per-request copy), the handler must skip
  // cleanup when ctx.home === resolverHome. We surface that via a flag.
  const result = await resolver.resolve({ headers: {} });
  assert.equal(result.persistent, true);
});
```

**Step 2: Run — expect failure**

```bash
node --test test/resolver-file.test.js
```
Expected: FAIL — `src/resolvers/file.js` doesn't exist.

### Task 2.2: Implement FileResolver

**Files:**
- Create: `src/resolvers/file.js`

**Step 1: Write minimal implementation**

```js
import path from "node:path";
import fs from "node:fs/promises";

/**
 * Single-user resolver. Reads OAuth credentials from a persistent
 * `$PROXY_CREDENTIALS_HOME/.claude/.credentials.json`. The directory
 * IS the home the spawned `claude` reads from — no per-request copy,
 * no tmpfs. That means writeback is a no-op: when claude refreshes the
 * token, it writes the new blob into that very file, which becomes the
 * starting point for the next request.
 *
 * `persistent: true` on the resolve result tells the handler NOT to
 * `rm -rf` the home dir after spawn exit. (Without that flag the very
 * next request would 503 with "credentials.json missing".)
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
              "PROXY_CREDENTIALS_HOME is unset — point it at a directory containing .claude/.credentials.json",
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
              `credentials.json not found at ${home}/.claude/.credentials.json — run 'claude login' against this HOME first`,
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

    async writeback(_ctx, _refreshed) {
      // The spawned claude wrote refreshed token into HOME directly.
      // Nothing to persist; it's already on disk.
    },
  };
}
```

**Step 2: Run resolver-file tests**

```bash
node --test test/resolver-file.test.js
```
Expected: all four tests pass.

**Step 3: Update server.js handler to respect `persistent`**

In `persistRefreshedTokenAndCleanup`, gate the `fs.rm` on `ctx.persistent !== true`:

```js
if (!ctx.persistent) {
  await fsp.rm(ctx.home, { recursive: true, force: true }).catch(() => {});
}
```

Run full suite:
```bash
npm test
```
Expected: green.

**Step 4: Commit**

```bash
git add src/resolvers/file.js src/server.js test/resolver-file.test.js
git commit -m "feat(resolvers): add single-user FileResolver"
```

### Task 2.3: End-to-end smoke against FileResolver

**Files:** none

**Step 1: Manual smoke test**

```bash
# Point at the local ~/.claude (which has a valid OAuth from `claude login`).
PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME node src/server.js &
sleep 1

# /healthz should not depend on DB anymore.
curl -s http://localhost:8080/healthz

# A trivial /v1/messages call.
curl -s -X POST http://localhost:8080/v1/messages \
  -H 'content-type: application/json' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{"model":"claude-haiku-4-5","max_tokens":32,"messages":[{"role":"user","content":"say hi"}]}'

kill %1
```
Expected: `/healthz` returns 200 with `claudeVersion`; `/v1/messages` returns a JSON response with an Anthropic-shape message (or a clean error from claude — but NOT a DB-error).

**Step 2: Commit any tweaks needed to make the smoke pass**

If the smoke test surfaced anything (e.g. the auth-skip path in `extractSessionToken`-checks deep in the handler), fix it as a small follow-up commit:
```bash
git commit -m "fix: FileResolver path skips session-token validation"
```

---

## Phase 3 — TokenMapResolver (optional, light)

**Why this phase exists:** Lets Hermes (or anyone) run a single proxy that serves multiple HOME-dirs via static tokens — e.g. one for Signal-channel, one for VSCode-channel — without dragging in Postgres.

### Task 3.1: Failing test for TokenMapResolver

**Files:**
- Create: `test/resolver-token-map.test.js`

**Step 1: Write tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { create } from "../src/resolvers/token-map.js";

async function fixture(map) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-"));
  const mapPath = path.join(dir, "tokens.json");
  await fs.writeFile(mapPath, JSON.stringify(map), "utf8");
  // Per-mapped-home: ensure .credentials.json exists.
  for (const home of Object.values(map).map((v) => v.home)) {
    await fs.mkdir(path.join(home, ".claude"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { access_token: "x" } }),
      "utf8",
    );
  }
  return mapPath;
}

test("token-map resolver: 401 when no token header", async () => {
  const mapPath = await fixture({});
  const r = create({ PROXY_TOKEN_MAP: mapPath });
  const result = await r.resolve({ headers: {} });
  assert.equal(result.error?.status, 401);
});

test("token-map resolver: maps token to oauth_claude home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "hcp-tm-home-"));
  const mapPath = await fixture({ "tok-vscode": { home } });
  const r = create({ PROXY_TOKEN_MAP: mapPath });
  const result = await r.resolve({ headers: { "x-api-key": "tok-vscode" } });
  assert.equal(result.mode, "oauth_claude");
  assert.equal(result.home, home);
  assert.equal(result.persistent, true);
});

test("token-map resolver: 401 on unknown token", async () => {
  const mapPath = await fixture({ "tok-known": { home: "/tmp" } });
  const r = create({ PROXY_TOKEN_MAP: mapPath });
  const result = await r.resolve({ headers: { "x-api-key": "tok-unknown" } });
  assert.equal(result.error?.status, 401);
});
```

**Step 2: Run — expect failure**

```bash
node --test test/resolver-token-map.test.js
```
Expected: FAIL — module missing.

### Task 3.2: Implement TokenMapResolver

**Files:**
- Create: `src/resolvers/token-map.js`

**Step 1: Implement**

```js
import path from "node:path";
import fs from "node:fs/promises";

import { extractSessionToken } from "../auth.js";

/**
 * Static `token → home` map loaded once at boot from a JSON file.
 * Format:
 *
 *   { "<token-string>": { "home": "/path/to/.claude-parent" } }
 *
 * Token shape is intentionally NOT enforced — any opaque string the
 * caller chooses works. Use long random values if the proxy is
 * reachable from outside trusted networks.
 */
export async function create(env) {
  const mapPath = env.PROXY_TOKEN_MAP;
  if (!mapPath) {
    throw new Error("PROXY_RESOLVER=token-map requires PROXY_TOKEN_MAP=/path/to/tokens.json");
  }
  const raw = await fs.readFile(mapPath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`PROXY_TOKEN_MAP must be a JSON object, got ${typeof parsed}`);
  }

  return {
    name: "token-map",

    async resolve(req) {
      const token = extractSessionToken(req);
      if (!token) {
        return { error: { status: 401, type: "authentication_error", message: "missing token (x-api-key or Authorization: Bearer …)" } };
      }
      const entry = parsed[token];
      if (!entry?.home) {
        return { error: { status: 401, type: "authentication_error", message: "unknown token" } };
      }
      try {
        await fs.access(path.join(entry.home, ".claude", ".credentials.json"));
      } catch {
        return {
          error: {
            status: 503,
            type: "configuration_error",
            message: `credentials.json missing in mapped home ${entry.home}`,
          },
        };
      }
      return {
        mode: "oauth_claude",
        home: entry.home,
        credId: token, // surface the token as id for logging
        persistent: true,
      };
    },

    async writeback() {
      // Same rationale as FileResolver — the spawned claude wrote into HOME.
    },
  };
}
```

Note: `create` is now async (we read the map file at boot). The dispatcher already awaits resolver factories, so this is fine.

**Step 2: Run tests**

```bash
node --test test/resolver-token-map.test.js
```
Expected: all three tests pass.

**Step 3: Commit**

```bash
git add src/resolvers/token-map.js test/resolver-token-map.test.js
git commit -m "feat(resolvers): add TokenMapResolver for multi-token single-process"
```

---

## Phase 4 — Slim down the core

**Why this phase exists:** Phase 1–3 added; nothing was removed yet. The whole point is that the *generic* proxy should not carry Specifyr-specific code in its main module.

### Task 4.1: Move auth.js into the pg-encrypted resolver folder

**Files:**
- Move: `src/auth.js` → `src/resolvers/pg-encrypted/auth.js`
- Move: `src/crypto.js` → `src/resolvers/pg-encrypted/crypto.js`
- Update imports in: `src/resolvers/pg-encrypted.js`, `test/auth.test.js`
- Update import in: `src/resolvers/token-map.js` (for `extractSessionToken`)

**Step 1: Move files**

```bash
mkdir -p src/resolvers/pg-encrypted
git mv src/auth.js src/resolvers/pg-encrypted/auth.js
git mv src/crypto.js src/resolvers/pg-encrypted/crypto.js
```

**Step 2: Hoist the `extractSessionToken` helper**

`extractSessionToken` and `looksLikeSessionToken` are generic — not Pg-specific. Move them to `src/lib/headers.js`:

```js
// src/lib/headers.js

export function extractSessionToken(req) {
  const auth = req.headers?.["authorization"];
  if (typeof auth === "string") {
    const m = /^bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim() || null;
  }
  const apiKey = req.headers?.["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  return null;
}

const TOKEN_REGEX = /^[0-9a-f]{64}$/;
export function looksLikeSessionToken(token) {
  return typeof token === "string" && TOKEN_REGEX.test(token);
}
```

Re-export those from `pg-encrypted/auth.js` for backward compat (until Task 4.3 cleans up the rename).

**Step 3: Update all import paths**

- `src/resolvers/pg-encrypted.js`: `../auth.js` → `./pg-encrypted/auth.js`, `../crypto.js` → `./pg-encrypted/crypto.js`, plus `extractSessionToken` etc. from `../lib/headers.js`
- `src/resolvers/token-map.js`: `../auth.js` → `../lib/headers.js`
- `test/auth.test.js`: `../src/auth.js` → `../src/resolvers/pg-encrypted/auth.js`

**Step 4: Run full suite**

```bash
npm test
```
Expected: green.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move pg+crypto into pg-encrypted resolver, hoist headers util"
```

### Task 4.2: Make `pg` an optional dependency

**Files:**
- Modify: `package.json`

**Step 1: Move pg to `optionalDependencies`**

```json
{
  "dependencies": {},
  "optionalDependencies": {
    "pg": "^8.20.0"
  }
}
```

**Step 2: Reinstall**

```bash
rm -rf node_modules package-lock.json
npm install
```

**Step 3: Confirm File-mode works without pg**

```bash
npm uninstall pg
PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME npm start &
sleep 1
curl -s http://localhost:8080/healthz
kill %1
npm install pg  # restore
```

Expected: `/healthz` returns 200 even without `pg` on disk, because `pg-encrypted.js` is only `import`-ed when `PROXY_RESOLVER=pg-encrypted`.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: mark pg as optional dependency (only pg-encrypted resolver needs it)"
```

### Task 4.3: README + CHANGELOG

**Files:**
- Modify: `README.md`
- Create: `CHANGELOG.md`

**Step 1: Rewrite README "How it works" section**

Replace the multi-tenant blurb with:

```markdown
## Resolvers

Pick how the proxy maps an inbound request to a `~/.claude` directory:

| `PROXY_RESOLVER` | Use case | Required env |
|---|---|---|
| `file` *(default)* | Single user, one machine | `PROXY_CREDENTIALS_HOME` (path to a dir containing `.claude/.credentials.json`) |
| `token-map` | Multiple static tokens → multiple homes, no DB | `PROXY_TOKEN_MAP` (path to JSON `{ "<token>": { "home": "..." } }`) |
| `pg-encrypted` | Multi-tenant via external Postgres + AES-GCM (Specifyr-compatible) | `DATABASE_URL`, `SPECIFYR_SECRET_KEY` |

`file` is the default — running `npm start` with just `PROXY_CREDENTIALS_HOME=$HOME`
points the proxy at your interactive `claude login` credentials. No DB. No
shared secret. No token handling.
```

**Step 2: Add CHANGELOG entry**

```markdown
# Changelog

## Unreleased

- Pluggable credential resolvers (`file`, `token-map`, `pg-encrypted`).
- `file` is now the default — `DATABASE_URL` is no longer required.
- `pg` is now an `optionalDependencies` entry.
- `src/auth.js` and `src/crypto.js` moved under `src/resolvers/pg-encrypted/`.
  External Specifyr deploys that imported from `src/auth.js` should update
  to the new path or import from the proxy's HTTP surface instead.
```

**Step 3: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document the three resolvers"
```

---

## Phase 5 — Verification

### Task 5.1: All tests pass + manual smoke

**Step 1: Run all unit tests**

```bash
npm test
```
Expected: all green; new test count = baseline + (resolver-dispatch + resolver-file + resolver-token-map tests).

**Step 2: Smoke FileResolver end-to-end**

Same as Task 2.3, repeat as a sanity check.

**Step 3: Smoke PgEncryptedResolver end-to-end** *(only if a Specifyr DB is reachable; skip otherwise — covered by Specifyr's own integration tests)*

```bash
PROXY_RESOLVER=pg-encrypted DATABASE_URL=... SPECIFYR_SECRET_KEY=... node src/server.js &
# … exercise /v1/messages with a valid runner_session token
```

### Task 5.2: Open PR / merge to main

Per [[user-role]] feedback the user creates PRs / merges himself. Stop here, summarise:

- Phase 1: resolver dispatcher + pg-encrypted wrapping existing logic
- Phase 2: FileResolver (Hermes default)
- Phase 3: TokenMapResolver
- Phase 4: core slimmed (pg optional, files moved)
- Phase 5: README/CHANGELOG/verification

---

## Risks / things the next engineer should think about

1. **Async dispatcher.** `createResolver` is now async. If anything else in `server.js` evaluated `pool` / `lookupSession` at module-import time, those references are now invalid. Phase 1.5 deletes the relevant top-level state — but re-grep `pool` and `lookupSession` after the refactor to be sure.

2. **`persistent: true` semantics.** FileResolver and TokenMapResolver point at *real* directories — never `rm -rf` them. The handler's `persistRefreshedTokenAndCleanup` gates the cleanup on `!ctx.persistent`. Miss that gate and you'll wipe the user's `~/.claude` on the first request. Cover with a focused server-level test if practical (small Express-style harness).

3. **API-key-forwarding stays in the core.** `forwardAnthropicMessages` (server.js around line 446) is generic — it consumes a `ctx.apiKey`/`ctx.baseUrl`. Any resolver that returns `mode: "api_key"` can use it. FileResolver doesn't return that mode today; add it only if you have a single-user use case for it.

4. **`extractSessionToken` is now shared.** PgEncryptedResolver requires hex-shaped tokens (`looksLikeSessionToken`); TokenMapResolver accepts opaque strings. Don't merge the two regex checks into one helper.

5. **The smoke test in Task 2.3 might hit the catch-all 404.** Look for `[proxy] 404 …` in stderr — Claude Code probes a few endpoints (`/v1/me`, `/v1/organizations/...`) on boot. They aren't required for `/v1/messages` to work, but log lines will be noisy.
