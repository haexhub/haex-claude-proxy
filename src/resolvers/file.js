export function create(_env) {
  return { name: "file", async resolve() { throw new Error("file resolver not implemented yet (Phase 2)"); } };
}
