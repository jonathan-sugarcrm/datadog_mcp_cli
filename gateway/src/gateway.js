import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { logCall } from './logger.js';

// Connects to the real Datadog MCP server as a child process over stdio.
// This is the single place holding the centrally managed Datadog
// credential (DD_API_KEY / DD_APP_KEY), inherited from this process's env.
// The SDK's StdioClientTransport defaults to a restricted env allowlist
// (HOME/PATH/etc.) when no `env` is given, which would silently drop
// DD_API_KEY/DD_APP_KEY/DD_SITE — the backend would never get its Datadog
// credential at all. Forward those three by name, same as this repo's own
// dd-mcp-proxy.sh convention for invoking the backend (forward the Datadog
// keys explicitly, nothing else) — not GATEWAY_API_KEY/GATEWAY_CLIENT_KEY,
// which the backend has no business seeing.
function backendEnv() {
  const env = getDefaultEnvironment();
  for (const key of ['DD_API_KEY', 'DD_APP_KEY', 'DD_SITE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

export async function connectBackend({ backendCommand, backendArgs }) {
  const transport = new StdioClientTransport({
    command: backendCommand,
    args: backendArgs,
    env: backendEnv(),
  });
  const client = new Client({ name: 'datadog-mcp-gateway-backend-client', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

export function filterTools(tools, allowlist) {
  if (!allowlist) return tools;
  return tools.filter((tool) => allowlist.has(tool.name));
}

// Builds the gateway-facing MCP server: it exposes only the allowlisted
// subset of the backend's tools, and forwards allowed calls to the backend.
export function buildGatewayServer({ backendClient, allowlist }) {
  const server = new Server(
    { name: 'datadog-mcp-gateway', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await backendClient.listTools();
    return { tools: filterTools(tools, allowlist) };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const startedAt = Date.now();

    if (allowlist && !allowlist.has(toolName)) {
      logCall({ tool: toolName, outcome: 'rejected', startedAt });
      // Standard MCP/JSON-RPC error object (code + message), not a bespoke
      // shape — see implementation.handoff.md decision log.
      throw new McpError(ErrorCode.MethodNotFound, `Tool not available: ${toolName}`);
    }

    try {
      const result = await backendClient.callTool(request.params);
      logCall({ tool: toolName, outcome: 'success', startedAt });
      return result;
    } catch (err) {
      logCall({ tool: toolName, outcome: 'failure', startedAt });
      throw err;
    }
  });

  return server;
}
