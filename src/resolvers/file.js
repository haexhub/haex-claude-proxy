// Stub - real implementation lands in Phase 2 (see docs/plans/2026-05-21-generic-resolver-refactor.md).
export function create(_env) {
  return { name: "file", async resolve() { throw new Error("file resolver not implemented yet (Phase 2)"); } };
}
