#!/usr/bin/env node
// Standalone Docker/Podman HEALTHCHECK probe for GET /healthz. Exists as a
// real file (rather than an inline `node -e "..."` one-liner in the Quadlet
// unit's HealthCmd=) because systemd's Quadlet directive parsing splits on
// whitespace/quotes like Environment= does — an inline command nesting both
// double and single quotes had its closing quote silently stripped, leaving
// the container permanently "unhealthy" (confirmed via `podman inspect`:
// `/bin/sh: Syntax error: Unterminated quoted string`).
// Explicit timeout so a wedged server fails the check within
// HealthTimeout=10s instead of hanging past it.
fetch("http://localhost:8080/healthz", { signal: AbortSignal.timeout(5000) })
  .then((res) => process.exit(res.ok ? 0 : 1))
  .catch(() => process.exit(1));
