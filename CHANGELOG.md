# Changelog

## [0.4.0](https://github.com/haexhub/haex-claude-proxy/compare/v0.3.0...v0.4.0) (2026-06-28)


### Features

* **auth:** DB-backed credentials with RLS + ephemeral tmpfs HOME ([#3](https://github.com/haexhub/haex-claude-proxy/issues/3)) ([79e43fa](https://github.com/haexhub/haex-claude-proxy/commit/79e43fae21447c5c427e07ca84f24aff95b319c9))
* **auth:** forward Anthropic api_key requests instead of spawning claude ([#4](https://github.com/haexhub/haex-claude-proxy/issues/4)) ([291b5dc](https://github.com/haexhub/haex-claude-proxy/commit/291b5dc038a2975caf3da56a10cf951b2c1b753d))
* **auth:** multi-tenant session-token resolver ([4d0e1ab](https://github.com/haexhub/haex-claude-proxy/commit/4d0e1ab15f691e9ae36206f63a41441b1b4d0817))
* **setup:** web-driven `claude auth login` via /setup/* endpoints ([#6](https://github.com/haexhub/haex-claude-proxy/issues/6)) ([d98a91a](https://github.com/haexhub/haex-claude-proxy/commit/d98a91aa94cf65604181ff386f4e752bfe007a20))
* wire structured-output tool schema through to claude --json-schema ([c265416](https://github.com/haexhub/haex-claude-proxy/commit/c2654161e95ba090b56c1b0a13fab32a09d1ccd3))


### Bug Fixes

* bump pinned claude CLI to 2.1.191 ([f1cec44](https://github.com/haexhub/haex-claude-proxy/commit/f1cec44e9fc0f1c0f9b3067e3f7dfe5b502aad0e))
* **cli-format:** add OpenAI&lt;-&gt;Anthropic helpers + drop tool inlining ([#2](https://github.com/haexhub/haex-claude-proxy/issues/2)) ([3d4fb4b](https://github.com/haexhub/haex-claude-proxy/commit/3d4fb4b1e1f6c64a676b19708338a265f12657bf))
* **docker:** chown PROXY_CREDENTIALS_HOME before dropping to node user ([0c2091c](https://github.com/haexhub/haex-claude-proxy/commit/0c2091c5450c36de275c77df1f9b7bba0c3594dc))
* ignore stale exit events from a process reset() already killed ([a2bd760](https://github.com/haexhub/haex-claude-proxy/commit/a2bd760352b174f1ebd93bb23935c802bd1aa466))
* serialize claude invocations sharing a credential HOME ([c5a3cbe](https://github.com/haexhub/haex-claude-proxy/commit/c5a3cbe79e6a2cef80776ce949702ee3c7fb6d4b))
* stop dropping the system prompt on POST /v1/messages ([a43f246](https://github.com/haexhub/haex-claude-proxy/commit/a43f24658cb1f8be06c98a3c2911d10607eca5c9))

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
