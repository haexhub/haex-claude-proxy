# Resolver contract

> Implementation plan: [`docs/plans/2026-05-21-generic-resolver-refactor.md`](../../docs/plans/2026-05-21-generic-resolver-refactor.md).

A Resolver is `{ name: string, resolve(req): Promise<ResolverResult>, writeback?(ctx, refreshedPlaintext): Promise<void> }`.

- `req` is the Node `http.IncomingMessage` of the inbound proxy request.
- `ctx` is the value returned by `resolve()` (one of the `ResolverResult` shapes below).
- `refreshedPlaintext` is the new credentials.json content read off disk after the `claude` subprocess exited.

Both `resolve` and `writeback` may be implemented as sync or async functions — callers always `await` them.

`ResolverResult` is one of:

```js
// On error — handler turns this into an HTTP error response.
{ error: { status: number, type: string, message: string } }

// OAuth-claude path — handler points the spawned `claude` at `home`,
// then either deletes that directory after spawn exit (default) or
// keeps it (`persistent: true`). After spawn exit, the handler calls
// `resolver.writeback(ctx, refreshedPlaintext)` if the resolver
// supports it.
{ mode: "oauth_claude",
  home: string,           // required: directory containing .claude/.credentials.json
  credId: string,         // required: opaque id, surfaces in logs
  persistent?: boolean,   // optional: if true, handler skips the post-spawn rm of `home`
  ownerKind?: string,     // optional: tenant routing (multi-tenant resolvers only)
  ownerId?: string        // optional: tenant routing (multi-tenant resolvers only)
}

// API-key passthrough — handler forwards the inbound request to the
// upstream API with the decrypted key. Stays in the core because every
// resolver implementation may want it.
{ mode: "api_key",
  credId: string,         // required
  provider: string,       // required (e.g. "anthropic")
  apiKey: string,         // required: decrypted upstream key
  baseUrl?: string|null,  // optional: per-tenant override
  ownerKind?: string,     // optional
  ownerId?: string        // optional
}
```

The `{ status, type, message }` shape matches the Anthropic API error envelope so handlers can JSON-stringify the inner object directly. `type` follows Anthropic's vocabulary (`authentication_error`, `invalid_request_error`, `api_error`, `configuration_error`).

`writeback` is optional on the shape above: it's called only when the spawn refreshed the OAuth token. Resolvers that don't persist credentials (e.g. `FileResolver` pointing at a writable home) can no-op.

**Resolver-internal fields.** Resolvers may attach private state to their result objects (e.g. the pg-encrypted plugin carries `_originalPlaintext` for refresh detection). Convention: prefix with `_` and ignore from the handler side.
