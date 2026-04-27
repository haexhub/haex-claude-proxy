# Phase 0 — Format Verification Findings

Captured 2026-04-27 against `claude` CLI v2.1.47.

Probe captures live in `tmp/probe-json.txt` and `tmp/probe-stream.txt` (gitignored).

## Environment gotcha

Running the proxy from a shell that already has `CLAUDECODE=1` (e.g. inside a
Claude Code session) makes the spawned `claude` subprocess refuse to start with:

> Error: Claude Code cannot be launched inside another Claude Code session.

Mitigation: the proxy must spawn `claude` with `CLAUDECODE` (and
`CLAUDE_CODE_ENTRYPOINT`) **explicitly removed from the child env**. In
production Docker the var is unset anyway, but local dev needs it.

## Non-streaming (`--output-format json`)

Real top-level keys:

```
duration_api_ms, duration_ms, is_error, modelUsage, num_turns,
permission_denials, result, session_id, stop_reason, subtype,
total_cost_usd, type, usage, uuid
```

Versus `claudeJsonToAnthropic()` assumptions:

| Assumption | Actual | Verdict |
|---|---|---|
| `claudeOut.result` is a string | yes | ✓ |
| `claudeOut.usage.input_tokens` / `output_tokens` | present | ✓ |
| `claudeOut.stop_reason` | observed `null`; our fallback to `"end_turn"` works | ✓ |
| (none — cache fields not handled) | `usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` are **the dominant cost dimension** (3 input vs 31190 cached in our probe) | **gap — must surface** |
| `claudeOut.messages` array | not emitted (we have `result` always) | dead branch — remove |

**Action items for Phase 1:**
1. Map `cache_creation_input_tokens` and `cache_read_input_tokens` into the
   Anthropic-format `usage` object.
2. Drop the `claudeOut.messages` fallback branch — `result` is always there.
3. No need to override `stop_reason` to `"end_turn"`; if claude emits null it
   means "not yet done". For a `--print` round-trip, claude *does* finish, so
   there's just no useful info — `"end_turn"` is a reasonable default.

## Streaming (`--output-format stream-json --include-partial-messages`)

Distinct event types observed in a 13-line trace:

| `type` (+ `subtype`/`event.type`)        | What it is                                |
|------------------------------------------|-------------------------------------------|
| `system/init`                            | startup config — ignore                   |
| `system/hook_started`, `system/hook_response` | claude internal hooks — ignore       |
| `rate_limit_event`                       | throttle hint — ignore for now            |
| `stream_event` (event.type=message_start) | **native Anthropic SSE event, wrapped** |
| `stream_event` (event.type=content_block_start) | "                                  |
| `stream_event` (event.type=content_block_delta) | "                                  |
| `stream_event` (event.type=content_block_stop)  | "                                  |
| `stream_event` (event.type=message_delta)       | "                                  |
| `stream_event` (event.type=message_stop)        | "                                  |
| `assistant`                              | final aggregated assistant message — redundant when streaming |
| `result/success`                         | final result block (same as non-stream `--output-format json` shape) |

**Sample `stream_event` body**:

```json
{
  "type": "stream_event",
  "event": {
    "type": "message_start",
    "message": { "id": "msg_…", "role": "assistant", "content": [], "model": "…", "usage": {…} }
  }
}
```

The inner `event` object **IS the Anthropic SSE-event payload**. No translation
required — the proxy unwraps `evt.event` and emits it as
`event: <evt.event.type>\ndata: <JSON>\n\n`.

## Decision: simplify `mapClaudeStreamEvent`

Replace the current synthesis-based implementation with a passthrough:

```js
export function mapClaudeStreamEvent(claudeEvt) {
  if (claudeEvt.type !== "stream_event" || !claudeEvt.event?.type) return null;
  return [{ event: claudeEvt.event.type, data: claudeEvt.event }];
}
```

Consequences:
- Drop the synthetic `message_start` we send before reading any output (claude
  emits its own).
- Drop the `alreadyStarted` flag — passthrough is stateless.
- The proxy stops emitting `message_stop` itself when claude exits 0 — claude
  already emits one (we keep the exit-handler `res.end()` and the error path).

## Skipped: Task 0.3 (hermes ANTHROPIC_BASE_URL behaviour)

Defers to Phase 4 deployment. Verification needs a built `hermes-agent` image,
which isn't relevant to a Phase-1 proxy MVP. The plan already documents the
fallback (entrypoint wrapper that runs `hermes config set`) if env doesn't
propagate.
