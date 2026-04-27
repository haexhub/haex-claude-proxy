# syntax=docker/dockerfile:1.7
#
# Image:  ghcr.io/haexhub/haex-claude-proxy:<tag>
# Built:  by .github/workflows/build-image.yml on push to main
# Runs:   `node src/server.js` listening on :8080
#
# At runtime the host's `~/.claude` (containing .credentials.json from a
# prior `claude auth login`) is bind-mounted read-only at /home/node/.claude
# by the deploying compose / ansible role. Without that mount the CLI has no
# OAuth session and every request will fail.

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# `claude` CLI lives globally so the spawned subprocess can be invoked by name.
# Pin to a major version to avoid surprise breaking changes from upstream;
# bump deliberately when verifying against the integration smoke.
RUN npm install -g @anthropic-ai/claude-code@2

WORKDIR /app
COPY package.json ./
COPY src/ ./src/

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0
EXPOSE 8080

# `claude` reads credentials from $HOME/.claude/.credentials.json. The base
# image creates a `node` user with HOME=/home/node, which is where the
# compose volume mount lands.
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
