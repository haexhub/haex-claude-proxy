// Minimal resolver fixture used by test/resolver-dispatch.test.js to
// exercise the external-module path of the dispatcher.
export function create(_env) {
  return {
    name: "fake",
    async resolve(_req) {
      return { error: { status: 500, type: "api_error", message: "fixture" } };
    },
  };
}
