# syntax=docker/dockerfile:1.7
#
# Image:  ghcr.io/haexhub/haex-claude-proxy:<tag>
# Built:  by .github/workflows/build-image.yml on push to main
# Runs:   `node src/server.js` listening on :8080
#
# Resolver-pluggable Anthropic-API-compatible proxy. The HTTP server
# picks a credential resolver at boot via PROXY_RESOLVER (default:
# `file`); builtins are `file` and `token-map`, external plugins are
# loaded as npm packages (e.g. haex-claude-proxy-resolver-pg for
# multi-tenant Postgres + AES-GCM).
#
# Optional web-driven setup flow: when PROXY_SETUP_TOKEN is set, three
# /setup/* routes expose the `claude auth login --claudeai` OAuth flow
# in a browser — start the flow, paste the code copied off
# platform.claude.com, get a credentials.json written to
# PROXY_CREDENTIALS_HOME without ever SSH-ing into the box. Requires
# node-pty (optional dependency built at image-build time).

FROM node:22-bookworm-slim

# Build-time deps for node-pty's native build (python3 + make + g++).
# Runtime deps for the proxy itself (ca-certificates + curl + tini).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl tini \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

# `claude` CLI lives globally so the spawned subprocess can be invoked
# by name. Pin to a specific minor version — 2.1.126 broke --print
# --output-format json (exits 0 with no output); bump only after
# verifying against the smoke test.
RUN npm install -g @anthropic-ai/claude-code@2.1.121

WORKDIR /app
COPY package.json package-lock.json* ./
# Production install: ships the optional node-pty if its native build
# succeeds (always does on bookworm with the build deps above). If a
# future deploy doesn't need the web-setup flow, dropping node-pty
# would only require removing PROXY_SETUP_TOKEN at runtime — the
# resolver paths don't import it.
RUN npm install --omit=dev --no-audit --no-fund
COPY src/ ./src/

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# `claude` reads credentials from $HOME/.claude/.credentials.json.
# The default `file` resolver expects PROXY_CREDENTIALS_HOME to point
# at a host bind-mount; the optional /setup/login flow writes into
# the same path when authoring a fresh login interactively.
#
# A fresh named volume (or empty bind-mount target) at that path is
# created by Docker as root:root, mode 0755 — unwritable by the
# non-root `node` user the app actually runs as (entrypoint drops
# privileges after chowning). Without that chown, `claude auth login`
# hangs indefinitely on a brand-new volume instead of failing fast or
# succeeding — confirmed by direct testing. See docker-entrypoint.sh.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
