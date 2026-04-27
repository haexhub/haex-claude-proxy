# haex-claude-proxy

Anthropic-API-compatible HTTP proxy that wraps the `claude` CLI as a subprocess.
Lets any Anthropic-API client (e.g. hermes-agent) consume a Claude Pro/Max
subscription via OAuth tokens instead of API credits.

## Status

Pre-MVP. See [docs/plans/2026-04-29-claude-oauth-proxy.md](docs/plans/2026-04-29-claude-oauth-proxy.md)
for the implementation plan.

## How it works

```
client (--provider anthropic         this proxy                claude CLI
        ANTHROPIC_BASE_URL=                                    (uses OAuth)
        http://haex-claude-proxy)    POST /v1/messages   →     api.anthropic.com
              ↓ HTTP                       ↓ subprocess
              POST /v1/messages       ←    claude --print …
                                           (json or stream-json)
```

The proxy is **stateless** — every request spawns a fresh `claude` subprocess
with `--no-session-persistence` and `--allowed-tools ""`. Tools defined in the
request are passed through as `tool_use` content blocks; the model returns
intents, the original caller (not this proxy) executes them.

## Run locally

```bash
npm start    # listens on :8080
```

Requires `claude` CLI on `$PATH` and an authenticated `~/.claude/.credentials.json`
(run `claude auth login` once interactively).

## Run tests

```bash
npm test                              # unit tests (no network)
CLAUDE_PROXY_E2E=1 npm test           # also runs gated integration tests
                                      # against the real claude CLI
```
