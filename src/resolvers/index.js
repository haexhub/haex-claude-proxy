/**
 * Resolver dispatch. Picks the resolver implementation based on
 * `PROXY_RESOLVER` (default: 'file'). Two builtin resolvers ship with
 * the proxy core; any other value is treated as an NPM module name (or
 * an absolute import specifier) and loaded via dynamic `import()`.
 *
 * The proxy core intentionally only ships generic resolvers. Specifyr
 * Postgres + AES-GCM lives in the separate `haex-claude-proxy-
 * resolver-pg` package — install it and set `PROXY_RESOLVER=haex-
 * claude-proxy-resolver-pg`.
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
  return factory(env);
}
