# syntax=docker/dockerfile:1.7
#
# Image:  ghcr.io/haexhub/haex-claude-proxy:<tag>
# Built:  by .github/workflows/build-image.yml on push to main
# Runs:   `node src/server.js` listening on :8080
#
# Multi-tenant only: each inbound request carries a runner_sessions
# token which the proxy resolves against specifyr's Postgres. The
# resolved (ownerKind, ownerId) selects a HOME under /credentials/
# (bind-mounted RW from the host) for the spawned `claude` CLI. No
# host `~/.claude` is mounted — every user's OAuth login lands in
# their own dir inside this container.

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# `claude` CLI lives globally so the spawned subprocess can be invoked by name.
# Pin to a specific minor version — 2.1.126 broke --print --output-format json
# (exits 0 with no output); bump only after verifying against the smoke test.
RUN npm install -g @anthropic-ai/claude-code@2.1.121

WORKDIR /app
COPY package.json package-lock.json* ./
# `pg` (Phase 7) is the only runtime dep — needed for the
# multi-tenant session-token resolver. Install with --omit=dev to keep
# the layer small and skip the test-runner deps.
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CREDENTIALS_ROOT=/credentials
EXPOSE 8080

# `claude` reads credentials from $HOME/.claude/.credentials.json.
# The spawned subprocess gets HOME pointed at
# /credentials/<owner_kind>/<owner_id> per request. Requests without
# a resolvable session token are rejected with 401 (no host
# fallback).
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
