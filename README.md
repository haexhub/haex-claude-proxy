# haex-claude-proxy

Anthropic-API-compatible HTTP proxy that wraps the `claude` CLI as a subprocess.
Lets any Anthropic-API client (e.g. hermes-agent, Cline, Roo Code) consume a
Claude Pro/Max subscription via OAuth tokens instead of API credits.

The proxy core is generic — credential resolution is pluggable.

## How it works

```text
client (--provider anthropic         this proxy                 upstream
        ANTHROPIC_BASE_URL=                                     ────────
        http://haex-claude-proxy)    POST /v1/messages   →      OAuth mode:
              ↓ HTTP                       ↓                    spawn `claude --print`
              POST /v1/messages            ↓                    (uses ~/.claude/.credentials.json)
                                           ↓
                                           ↓                    api_key mode:
                                           ↓                    HTTPS to api.anthropic.com
                                                                with the resolved key
```

Each request hits the resolver first. Depending on what the resolver returns,
the proxy either:

- **`oauth_claude`** — spawns a fresh `claude` subprocess with
  `--no-session-persistence` and `--allowed-tools ""`, pointed at a per-request
  HOME containing the resolved `.credentials.json`. Tools defined in the
  request are passed through as `tool_use` content blocks; the model returns
  intents, the original caller (not this proxy) executes them.
- **`api_key`** — forwards the request straight to `api.anthropic.com` (or a
  per-tenant `baseUrl`) with the decrypted upstream key. No subprocess.

## Resolvers

Which `~/.claude` directory a request talks to is decided by a resolver. Pick
one via `PROXY_RESOLVER`:

| `PROXY_RESOLVER` | Use case | Required env |
|---|---|---|
| `file` *(default)* | Single user, one machine | `PROXY_CREDENTIALS_HOME` (path to a directory with `.claude/.credentials.json`) |
| `token-map` | Multiple static tokens → multiple homes, no DB | `PROXY_TOKEN_MAP` (path to JSON `{ "<token>": { "home": "..." } }`) |
| _NPM module name_ | Anything else — install a resolver plugin and point `PROXY_RESOLVER` at its package name | depends on the plugin |

Builtins ship with the proxy core. External resolvers are loaded via dynamic
`import()` — install with pnpm and the dispatcher picks them up.

### Available external resolvers

- [`haex-claude-proxy-resolver-pg`](https://www.npmjs.com/package/haex-claude-proxy-resolver-pg) — Postgres + AES-GCM. Tenant-aware credential store with RLS; resolves 64-hex session tokens against a `runner_sessions` table.

To use:

```bash
pnpm add file:../haex-claude-proxy-resolver-pg
PROXY_RESOLVER=haex-claude-proxy-resolver-pg
DATABASE_URL=postgres://...
SPECIFYR_SECRET_KEY=<64-hex master key>
pnpm start
```

## Endpoints

- `POST /v1/messages` — Anthropic Messages API.
- `POST /v1/chat/completions` — OpenAI-compatible alias (also accepts
  `/chat/completions` without the `/v1` prefix).
- `GET /v1/models` — static list (Claude Code probes this on startup).
- `GET /v1/models/{id}` — single-model lookup.
- `GET /healthz` — liveness check + a synthetic `claude --version`.

### Setup endpoints (optional)

When `PROXY_SETUP_TOKEN` and `PROXY_CREDENTIALS_HOME` are both set, the proxy
exposes a bearer-token-protected web UI that wraps `claude auth login
--claudeai`. Useful for headless deployments where you can't shell into the
container to run the interactive CLI.

- `GET  /setup/` — HTML page that drives the flow in the browser.
- `GET  /setup/status` — JSON snapshot of the state machine.
- `POST /setup/login` — starts the spawn, returns `{ oauthUrl }`.
- `POST /setup/code` — submits the OAuth code copied off `platform.claude.com`.
- `POST /setup/reset` — kills any in-flight flow.

All routes require either `Authorization: Bearer <PROXY_SETUP_TOKEN>` or
`?token=<PROXY_SETUP_TOKEN>`. With `PROXY_SETUP_TOKEN` unset, the entire
`/setup/*` surface returns 404. Requires `node-pty` (optional dependency).

Generate a token with `openssl rand -hex 32`.

## Run locally

```bash
PROXY_RESOLVER=file PROXY_CREDENTIALS_HOME=$HOME pnpm start
```

That points the resolver at your interactive `claude login` credentials. Runs
on `:8080` (override with `PORT`).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | HTTP listen port |
| `HOST` | `0.0.0.0` | Listen host |
| `PROXY_RESOLVER` | `file` | Resolver name (see above) |
| `PROXY_CREDENTIALS_HOME` | — | Used by `file` resolver and `/setup/*` |
| `PROXY_TOKEN_MAP` | — | Used by `token-map` resolver |
| `PROXY_SETUP_TOKEN` | — | Enables `/setup/*` when set |
| `ALLOWED_FORWARD_HOSTS` | `api.anthropic.com` | Comma-separated allowlist for `api_key`-mode forwarding |
| `PROXY_UPSTREAM_TIMEOUT_MS` | `120000` | Per-request timeout when forwarding |
| `CLAUDE_BIN` | `claude` | Path to the `claude` CLI binary |

## Run tests

```bash
pnpm test                             # unit tests (no network)
CLAUDE_PROXY_E2E=1 pnpm test          # also runs gated integration tests
                                      # against the real claude CLI
```

## Status

Recent changes:

- Web-driven `claude auth login` via `/setup/*` endpoints (see Setup endpoints
  above).
- `api_key` resolver mode forwards requests directly to `api.anthropic.com`
  instead of spawning the CLI.
- Pluggable resolvers, Pg+AES extracted to the
  [`haex-claude-proxy-resolver-pg`](https://www.npmjs.com/package/haex-claude-proxy-resolver-pg)
  plugin, `FileResolver` is the default. See
  [docs/plans/2026-05-21-generic-resolver-refactor.md](docs/plans/2026-05-21-generic-resolver-refactor.md)
  and [src/resolvers/types.md](src/resolvers/types.md) for the resolver
  contract.

See [CHANGELOG.md](CHANGELOG.md) for the full release history.
