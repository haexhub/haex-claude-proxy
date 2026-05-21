# haex-claude-proxy

Anthropic-API-compatible HTTP proxy that wraps the `claude` CLI as a subprocess.
Lets any Anthropic-API client (e.g. hermes-agent, Cline, Roo Code) consume a
Claude Pro/Max subscription via OAuth tokens instead of API credits.

The proxy core is generic — credential resolution is pluggable.

## How it works

```
client (--provider anthropic         this proxy               claude CLI
        ANTHROPIC_BASE_URL=                                   (uses OAuth)
        http://haex-claude-proxy)    POST /v1/messages   →    api.anthropic.com
              ↓ HTTP                       ↓ subprocess
              POST /v1/messages       ←    claude --print …
                                           (json or stream-json)
```

Every request spawns a fresh `claude` subprocess with `--no-session-persistence`
and `--allowed-tools ""`. Tools defined in the request are passed through as
`tool_use` content blocks; the model returns intents, the original caller (not
this proxy) executes them.

## Resolvers

Which `~/.claude` directory a request talks to is decided by a resolver. Pick
one via `PROXY_RESOLVER`:

| `PROXY_RESOLVER` | Use case | Required env |
|---|---|---|
| `file` *(default)* | Single user, one machine | `PROXY_CREDENTIALS_HOME` (path to a directory with `.claude/.credentials.json`) |
| `token-map` | Multiple static tokens → multiple homes, no DB | `PROXY_TOKEN_MAP` (path to JSON `{ "<token>": { "home": "..." } }`) |
| _NPM module name_ | Anything else — install a resolver plugin and point `PROXY_RESOLVER` at its package name | depends on the plugin |

Builtins ship with the proxy core. External resolvers are loaded via dynamic
`import()` — install with npm and the dispatcher picks them up.

### Available external resolvers

- [`haex-claude-proxy-resolver-pg`](../haex-claude-proxy-resolver-pg/) — Postgres + AES-GCM. Tenant-aware credential store with RLS; resolves 64-hex session tokens against a `runner_sessions` table.

To use:

```bash
npm install file:../haex-claude-proxy-resolver-pg
PROXY_RESOLVER=haex-claude-proxy-resolver-pg
DATABASE_URL=postgres://...
SPECIFYR_SECRET_KEY=<64-hex master key>
npm start
```

## Endpoints

- `POST /v1/messages` — Anthropic Messages API.
- `POST /v1/chat/completions` — OpenAI-compatible alias.
- `GET /v1/models` — static list (Claude Code probes this on startup).
- `GET /v1/models/{id}` — single-model lookup.
- `GET /healthz` — liveness check + a synthetic `claude --version`.

## Run locally

```bash
PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME npm start
```

That points the resolver at your interactive `claude login` credentials. Runs
on `:8080` (override with `PORT`).

## Run tests

```bash
npm test                              # unit tests (no network)
CLAUDE_PROXY_E2E=1 npm test           # also runs gated integration tests
                                      # against the real claude CLI
```

## Status

See [docs/plans/2026-05-21-generic-resolver-refactor.md](docs/plans/2026-05-21-generic-resolver-refactor.md)
for the most recent refactor (Pg+AES extracted to a standalone plugin, FileResolver
became the default).
