# Resolver contract

A Resolver is `{ name: string, resolve(req): Promise<ResolverResult> }`.

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

Optional method: `writeback(ctx, refreshedPlaintext): Promise<void>` — called only
when the spawn refreshed the OAuth token. Resolvers that don't persist
credentials (e.g. `FileResolver` pointing at a writable home) can no-op.
