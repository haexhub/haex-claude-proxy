// Stub - real implementation lands in Phase 1.4 (see docs/plans/2026-05-21-generic-resolver-refactor.md).
export function create(_env) {
  return { name: "pg-encrypted", async resolve() { throw new Error("pg-encrypted resolver not implemented yet (Phase 1.4)"); } };
}
