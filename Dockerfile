# syntax=docker/dockerfile:1.7
#
# Image:  ghcr.io/haexhub/haex-claude-proxy:<tag>
# Built:  by .github/workflows/build-image.yml on push to main
# Runs:   `node src/server.js` listening on :8080
#
# Multi-tenant only: each inbound request carries a runner_sessions
# token which the proxy resolves against specifyr's Postgres, then
# pulls the encrypted oauth credential from the llm_credentials table
# (RLS-aware) and decrypts it with SPECIFYR_SECRET_KEY in-process. The
# plaintext is staged in a per-request ephemeral HOME under
# CREDENTIALS_ROOT (default /run/credentials) — meant to be a tmpfs in
# production — and is removed after the spawned `claude` CLI exits.
# Any refreshed access-token is encrypted back into the DB.
#
# Runtime requirements (set by the deployment, not the image):
#   - DATABASE_URL pointed at specifyr's Postgres
#   - SPECIFYR_SECRET_KEY (64 hex chars; identical to specifyr's)
#   - tmpfs mount at CREDENTIALS_ROOT, uid=node, mode 0700
# No host bind-mount for credentials. No `~/.claude` fallback.

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
    HOST=0.0.0.0
EXPOSE 8080

# `claude` reads credentials from $HOME/.claude/.credentials.json.
# Per request the proxy decrypts the owner's oauth blob from the DB,
# writes it into a fresh dir under CREDENTIALS_ROOT (defaulted in
# server.js to /run/credentials, expected to be a tmpfs at runtime),
# points HOME there for the `claude` spawn, and rm-rf's the dir after
# exit. Requests without DATABASE_URL or SPECIFYR_SECRET_KEY → 503;
# tokens that don't resolve → 401.
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
