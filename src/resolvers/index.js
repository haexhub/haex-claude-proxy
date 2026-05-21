/**
 * Resolver dispatch. Picks the resolver implementation based on
 * `PROXY_RESOLVER` (default: 'file'). Each resolver module exports
 * a `create(env)` factory; the dispatcher routes and awaits.
 *
 * Async because resolvers may do I/O at startup (read a token map,
 * connect a pg pool). Errors at factory time surface here.
 */
export async function createResolver(env = process.env) {
  const kind = (env.PROXY_RESOLVER ?? "file").toLowerCase();
  switch (kind) {
    case "file":         return (await import("./file.js")).create(env);
    case "token-map":    return (await import("./token-map.js")).create(env);
    case "pg-encrypted": return (await import("./pg-encrypted.js")).create(env);
    default:
      throw new Error(`unknown resolver '${kind}' — expected file|token-map|pg-encrypted`);
  }
}
