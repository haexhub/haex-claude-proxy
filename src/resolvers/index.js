/**
 * Resolver dispatch. Picks the resolver implementation based on
 * `PROXY_RESOLVER` (default: 'file'). Two builtin resolvers ship with
 * the proxy core; any other value is treated as an NPM module name (or
 * an absolute import specifier) and loaded via dynamic `import()`.
 *
 * The proxy core intentionally ships only generic resolvers. For
 * Specifyr-flavoured Postgres + AES-GCM, install the separate
 * `haex-claude-proxy-resolver-pg` package and set
 * `PROXY_RESOLVER=haex-claude-proxy-resolver-pg`.
 *
 * Each resolver module exports a `create(env)` factory returning
 * `{ name, resolve, writeback? }`. The dispatcher awaits the factory
 * so resolvers can do startup I/O (read a token map, connect a pool).
 *
 * @param {NodeJS.ProcessEnv | Record<string, string|undefined>} [env]
 * @returns {Promise<{ name: string, resolve: Function, writeback?: Function }>}
 */
export async function createResolver(env = process.env) {
  const raw = env.PROXY_RESOLVER ?? "file";
  const builtin = raw.toLowerCase();

  if (builtin === "file")      return (await import("./file.js")).create(env);
  if (builtin === "token-map") return (await import("./token-map.js")).create(env);

  // External resolver module. NPM package name (e.g. 'haex-claude-proxy-
  // resolver-pg') or absolute path. Case-sensitive: we use the raw value,
  // not the lowercased one, because npm names are case-sensitive.
  let mod;
  try {
    mod = await import(raw);
  } catch (err) {
    if (err.code === "ERR_MODULE_NOT_FOUND" || err.code === "MODULE_NOT_FOUND") {
      throw new Error(
        `resolver module not found: '${raw}'. Builtins: file, token-map. ` +
        `Install external resolvers via npm.`,
      );
    }
    throw err;
  }
  const factory = mod.create ?? mod.default?.create;
  if (typeof factory !== "function") {
    throw new Error(
      `resolver module '${raw}' must export create(env) (got ${typeof factory})`,
    );
  }
  // Wrap the factory call so plugin boot-time errors carry a clear
  // hint that they came from PROXY_RESOLVER, not the proxy core.
  let resolver;
  try {
    resolver = await factory(env);
  } catch (err) {
    throw new Error(
      `resolver module '${raw}' create() failed: ${err?.message ?? String(err)}`,
      { cause: err },
    );
  }
  // Fail fast against the documented resolver shape — otherwise a misbehaving
  // plugin lets the server boot and surfaces only on the first request.
  if (!resolver || typeof resolver !== "object") {
    throw new Error(`resolver module '${raw}' create(env) must return an object`);
  }
  if (typeof resolver.name !== "string" || !resolver.name) {
    throw new Error(`resolver module '${raw}' must return a non-empty string 'name'`);
  }
  if (typeof resolver.resolve !== "function") {
    throw new Error(`resolver module '${raw}' must return a 'resolve(req)' function`);
  }
  if (resolver.writeback != null && typeof resolver.writeback !== "function") {
    throw new Error(`resolver module '${raw}' 'writeback' must be a function when provided`);
  }
  return resolver;
}
