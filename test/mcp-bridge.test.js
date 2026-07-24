/**
 * Drives `src/mcp-bridge/bridge-server.js` as a REAL subprocess over real MCP
 * JSON-RPC (stdio), pointed at an in-test `node:http` fake callback target —
 * Stage 1 of the plan's staged rollout. No real `claude` CLI involved (that's
 * Stage 2, gated by CLAUDE_PROXY_E2E).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE_SCRIPT = join(here, "..", "src", "mcp-bridge", "bridge-server.js");

/** Start a fake callback HTTP server; `handler(parsedBody, res)` decides the response. */
function startFakeCallback(handler) {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end("bad json");
        return;
      }
      handler(parsed, res, req);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/** Connect a real MCP client to a freshly spawned bridge-server.js child process. */
async function connectBridge({ tools, callbackUrl, callbackToken, timeoutMs = 5000 }) {
  const transport = new StdioClientTransport({
    command: "node",
    args: [BRIDGE_SCRIPT],
    env: {
      MCP_BRIDGE_TOOLS: JSON.stringify(tools),
      MCP_BRIDGE_CALLBACK_URL: callbackUrl ?? "",
      MCP_BRIDGE_CALLBACK_TOKEN: callbackToken ?? "",
      MCP_BRIDGE_TOOL_TIMEOUT_MS: String(timeoutMs),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  return { client, transport };
}

test("mcp-bridge: tools/list returns the configured tool defs verbatim", async () => {
  const tools = [
    { name: "search_web_tool", description: "search the web", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  ];
  const { client, transport } = await connectBridge({ tools, callbackUrl: "http://127.0.0.1:1/unused", callbackToken: "tok" });
  try {
    const result = await client.listTools();
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, "search_web_tool");
    assert.equal(result.tools[0].description, "search the web");
    assert.deepEqual(result.tools[0].inputSchema, tools[0].inputSchema);
  } finally {
    await client.close();
    await transport.close();
  }
});

test("mcp-bridge: tools/call round-trips a real result through the callback", async () => {
  const server = await startFakeCallback((body, res) => {
    assert.equal(body.tool_name, "search_web_tool");
    assert.deepEqual(body.args, { query: "RSI mean reversion" });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: [{ url: "https://x", title: "X" }] }));
  });
  const { port } = server.address();
  const { client, transport } = await connectBridge({
    tools: [{ name: "search_web_tool", description: "d", inputSchema: { type: "object" } }],
    callbackUrl: `http://127.0.0.1:${port}/cb`,
    callbackToken: "secret-tok",
  });
  try {
    const result = await client.callTool({ name: "search_web_tool", arguments: { query: "RSI mean reversion" } });
    assert.equal(result.isError, undefined);
    assert.equal(result.content[0].type, "text");
    assert.deepEqual(JSON.parse(result.content[0].text), [{ url: "https://x", title: "X" }]);
  } finally {
    await client.close();
    await transport.close();
    server.close();
  }
});

test("mcp-bridge: sends the callback token as X-Internal-Tool-Key", async () => {
  let seenHeader = null;
  const server = await startFakeCallback((body, res, req) => {
    seenHeader = req.headers["x-internal-tool-key"];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, result: "fine" }));
  });
  const { port } = server.address();
  const { client, transport } = await connectBridge({
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    callbackUrl: `http://127.0.0.1:${port}/cb`,
    callbackToken: "secret-tok-xyz",
  });
  try {
    await client.callTool({ name: "t", arguments: {} });
    assert.equal(seenHeader, "secret-tok-xyz");
  } finally {
    await client.close();
    await transport.close();
    server.close();
  }
});

test("mcp-bridge: callback returning ok:false maps to isError:true (not a thrown/hung call)", async () => {
  const server = await startFakeCallback((body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "tool raised ValueError" }));
  });
  const { port } = server.address();
  const { client, transport } = await connectBridge({
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    callbackUrl: `http://127.0.0.1:${port}/cb`,
    callbackToken: "tok",
  });
  try {
    const result = await client.callTool({ name: "t", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /tool raised ValueError/);
  } finally {
    await client.close();
    await transport.close();
    server.close();
  }
});

test("mcp-bridge: non-2xx callback response maps to isError:true", async () => {
  const server = await startFakeCallback((body, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("internal error");
  });
  const { port } = server.address();
  const { client, transport } = await connectBridge({
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    callbackUrl: `http://127.0.0.1:${port}/cb`,
    callbackToken: "tok",
  });
  try {
    const result = await client.callTool({ name: "t", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /500/);
  } finally {
    await client.close();
    await transport.close();
    server.close();
  }
});

test("mcp-bridge: unreachable callback host maps to isError:true, doesn't hang", async () => {
  const { client, transport } = await connectBridge({
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    // Port with nothing listening — real socket refusal is the fastest way to
    // simulate "the callback host is unreachable".
    callbackUrl: "http://127.0.0.1:1/cb",
    callbackToken: "tok",
    timeoutMs: 5000,
  });
  try {
    const result = await client.callTool({ name: "t", arguments: {} });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
    await transport.close();
  }
});

test("mcp-bridge: a slow callback past the timeout maps to isError:true, doesn't hang the CLI's loop", async () => {
  const server = await startFakeCallback(() => {
    // Never responds — bridge's own timeout must still resolve the call.
  });
  const { port } = server.address();
  const { client, transport } = await connectBridge({
    tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
    callbackUrl: `http://127.0.0.1:${port}/cb`,
    callbackToken: "tok",
    timeoutMs: 300,
  });
  try {
    const result = await client.callTool({ name: "t", arguments: {} });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /timed out/);
  } finally {
    await client.close();
    await transport.close();
    server.close();
  }
});
