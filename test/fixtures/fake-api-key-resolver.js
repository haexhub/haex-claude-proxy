// Resolver fixture for passthrough tests. It returns an Anthropic api_key
// credential whose upstream base URL points at the test's local fake server.
export function create(env) {
  return {
    name: "fake-api-key",
    async resolve(_req) {
      return {
        mode: env.FAKE_ANTHROPIC_MODE || "api_key",
        provider: "anthropic",
        apiKey: env.FAKE_ANTHROPIC_API_KEY || "upstream-key",
        baseUrl: env.FAKE_ANTHROPIC_BASE_URL,
      };
    },
  };
}
