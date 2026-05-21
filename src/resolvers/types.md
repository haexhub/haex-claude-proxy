# Resolver contract

> Implementation plan: [`docs/plans/2026-05-21-generic-resolver-refactor.md`](../../docs/plans/2026-05-21-generic-resolver-refactor.md).

A Resolver is `{ name: string, resolve(req): Promise<ResolverResult>, writeback?(ctx, refreshedPlaintext): Promise<void> }`.

- `req` is the Node `http.IncomingMessage` of the inbound proxy request.
- `ctx` is the value returned by `resolve()` (one of the `ResolverResult` shapes below).
- `refreshedPlaintext` is the new credentials.json content read off disk after the `claude` subprocess exited.

`ResolverResult` is one of:

```js
// On error — handler turns this into an HTTP error response.
{ error: { status: number, type: string, message: string } }

// OAuth-claude path — handler stages a per-request tmpfs HOME with the
// plaintext credentials and spawns `claude --print`. After spawn exit,
// the handler calls `resolver.writeback(ctx, refreshedPlaintext)` if the
// resolver supports it.
{ mode: "oauth_claude", home: string, credId: string, ownerKind?: string, ownerId?: string }

// API-key passthrough — handler forwards the inbound request to the
// upstream API with the decrypted key. Stays in the core because every
// resolver implementation may want it.
{ mode: "api_key", credId: string, provider: string, apiKey: string, baseUrl?: string|null,
  ownerKind?: string, ownerId?: string }
```

The `{ status, type, message }` shape matches the Anthropic API error envelope so handlers can JSON-stringify the inner object directly. `type` follows Anthropic's vocabulary (`authentication_error`, `invalid_request_error`, `api_error`, etc.).

`writeback` is optional on the shape above: it's called only when the spawn refreshed the OAuth token. Resolvers that don't persist credentials (e.g. `FileResolver` pointing at a writable home) can no-op.
