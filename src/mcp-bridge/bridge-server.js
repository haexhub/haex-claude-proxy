#!/usr/bin/env node
/**
 * Stdio MCP server the `claude` CLI spawns itself (via `--mcp-config`, see
 * `cli-format.js`'s `buildMcpBridgeConfig`) so its own internal agent loop
 * can call a caller's real function tools mid-task and get a genuine result
 * back — all within one `--print` invocation.
 *
 * Every `tools/call` is forwarded as an authenticated HTTP callback into the
 * caller (fwbg-agents' `POST /internal/tool-exec/{agent_run_id}`), which
 * invokes the *same* live tool closure pydantic-ai already built for that
 * run and returns its result.
 *
 * Configured entirely via env vars set on this child process (never argv,
 * so a callback URL/token never shows up in `ps auxww`):
 *   MCP_BRIDGE_TOOLS             JSON array of {name, description, inputSchema}
 *   MCP_BRIDGE_CALLBACK_URL      where to POST {tool_name, args}
 *   MCP_BRIDGE_CALLBACK_TOKEN    sent as X-Internal-Tool-Key
 *   MCP_BRIDGE_TOOL_TIMEOUT_MS   per-call budget
 *
 * Never throws out of a request handler and never hangs past its timeout —
 * a wedged or unreachable callback maps to a normal `CallToolResult` with
 * `isError: true` so the CLI's own loop always gets *something* back and
 * can keep going (e.g. try a different tool, or give up and emit its final
 * structured output).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const TOOLS = JSON.parse(process.env.MCP_BRIDGE_TOOLS ?? "[]");
const CALLBACK_URL = process.env.MCP_BRIDGE_CALLBACK_URL;
const CALLBACK_TOKEN = process.env.MCP_BRIDGE_CALLBACK_TOKEN;
const TOOL_TIMEOUT_MS = Number(process.env.MCP_BRIDGE_TOOL_TIMEOUT_MS ?? 60_000);

/**
 * POST one tool call to the callback URL and map every outcome — success,
 * timeout, network failure, non-2xx — to a `CallToolResult`. Exported for
 * unit testing without spawning the server over stdio.
 *
 * @param {string} name
 * @param {object} args
 * @returns {Promise<{content: Array<{type: string, text: string}>, isError?: boolean}>}
 */
export async function callBridgedTool(name, args) {
  if (!CALLBACK_URL || !CALLBACK_TOKEN) {
    return errorResult("bridge misconfigured: missing callback URL/token");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("tool call timed out")), TOOL_TIMEOUT_MS);
  try {
    const resp = await fetch(CALLBACK_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Internal-Tool-Key": CALLBACK_TOKEN,
      },
      body: JSON.stringify({ tool_name: name, args }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return errorResult(`callback returned ${resp.status}: ${text.slice(0, 500)}`);
    }
    const data = await resp.json();
    if (data?.ok === true) {
      const text = typeof data.result === "string" ? data.result : JSON.stringify(data.result ?? null);
      return { content: [{ type: "text", text }] };
    }
    return errorResult(String(data?.error ?? "tool call failed"));
  } catch (e) {
    const reason = e.name === "AbortError" ? "timed out" : e.message;
    return errorResult(`callback request failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

const server = new Server(
  { name: "fwbg-bridge", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return callBridgedTool(name, args ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
