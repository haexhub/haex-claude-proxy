#!/bin/sh
# Docker creates a brand-new named volume (or empty bind-mount target)
# owned by root:root, mode 0755 — unwritable by the non-root `node`
# user this image runs as. The `file` resolver's PROXY_CREDENTIALS_HOME
# (and the /setup/login flow's `claude auth login`, which needs to
# write `$HOME/.claude/.credentials.json`) both write into that path.
# Without this fix-up, `claude auth login` hangs indefinitely on first
# boot against a fresh volume instead of failing fast — it never even
# prints the OAuth URL, because the failure happens deep inside the CLI
# before it gets a chance to surface a clean error on its controlling
# PTY. Chowning here (root, before we drop to `node` below) makes a
# fresh volume work exactly like a pre-chowned one.
set -e

if [ -n "$PROXY_CREDENTIALS_HOME" ] && [ -d "$PROXY_CREDENTIALS_HOME" ]; then
  chown -R node:node "$PROXY_CREDENTIALS_HOME" 2>/dev/null || true
fi

# `$*` (not "$@") deliberately: shadow-utils' `su -c` takes a single
# command string, not an argv array. Fine for this image's fixed
# `node src/server.js` CMD — none of its words contain spaces/quotes.
exec su -s /bin/sh node -c "exec $*"
