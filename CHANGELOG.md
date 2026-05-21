# Changelog

## 0.3.0 — Unreleased

**Breaking config change.** `DATABASE_URL` and `SPECIFYR_SECRET_KEY` are no
longer recognised in the proxy core. Pg+AES credential resolution moved to a
separate package, `haex-claude-proxy-resolver-pg`.

### Added

- Pluggable credential resolvers via `PROXY_RESOLVER` env var.
- `file` resolver (new default) — single-user, reads from
  `$PROXY_CREDENTIALS_HOME/.claude/.credentials.json`. No DB, no crypto, no
  token handling.
- `token-map` resolver — static `token → home` map loaded once at boot from a
  JSON file pointed at by `PROXY_TOKEN_MAP`. To rotate tokens, restart the
  proxy.
- External resolver loading: any non-builtin `PROXY_RESOLVER` value is treated
  as an NPM module name (or import specifier) and loaded via dynamic
  `import()`. The module must export `create(env)` returning
  `{ name, resolve, writeback? }`.
- `src/resolvers/types.md` — the resolver contract.
- Contract: `persistent?: boolean` field on the `oauth_claude` result. When
  `true`, the server keeps the resolver's HOME directory across requests
  (used by `file` and `token-map`). Default (`undefined` or `false`) means
  the server `rm -rf`s HOME after the spawn exits.
- Contract: resolvers may attach internal state to result objects using
  `_`-prefixed keys (e.g. `_originalPlaintext`); the server ignores them.
- `.gitignore` entry for `.worktrees/`.

### Removed

- `src/auth.js`, `src/crypto.js`, `test/auth.test.js` — moved to the
  `haex-claude-proxy-resolver-pg` plugin.
- `pg` from `dependencies` — proxy core has no runtime deps.
- Built-in `pg-encrypted` resolver case (now an external module).
- `DATABASE_URL` / `SPECIFYR_SECRET_KEY` / `CREDENTIALS_ROOT` handling in
  `server.js`.

### Migration

- Specifyr-style multi-tenant deploys: install the plugin and set
  `PROXY_RESOLVER=haex-claude-proxy-resolver-pg`. Other env vars
  (`DATABASE_URL`, `SPECIFYR_SECRET_KEY`, `CREDENTIALS_ROOT`) keep their
  meaning inside the plugin.
- Single-user deploys: `PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME` is
  the new minimal config.
