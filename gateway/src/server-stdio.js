import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { keysMatch } from './auth.js';
import { buildGatewayServer, connectBackend } from './gateway.js';

// Local/Docker mode: the launcher must present GATEWAY_CLIENT_KEY matching
// the server's GATEWAY_API_KEY before the process will connect to the
// backend or serve any MCP traffic over stdio.
export async function runStdio(config) {
  if (!keysMatch(config.clientKey, config.apiKey)) {
    process.stderr.write('datadog-mcp-gateway: rejected — missing or invalid GATEWAY_CLIENT_KEY\n');
    process.exitCode = 1;
    return;
  }

  const backendClient = await connectBackend(config);
  const server = buildGatewayServer({ backendClient, allowlist: config.allowlist });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
