// Stub - real implementation lands in Phase 3 (see docs/plans/2026-05-21-generic-resolver-refactor.md).
export function create(_env) {
  return { name: "token-map", async resolve() { throw new Error("token-map resolver not implemented yet (Phase 3)"); } };
}
