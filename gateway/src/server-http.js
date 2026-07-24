import { createServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { keysMatch } from './auth.js';
import { buildGatewayServer, connectBackend } from './gateway.js';

// HTTP-transport analogue of stdio's GATEWAY_CLIENT_KEY gate: over HTTP the
// shared secret travels per-request in a header rather than once at launch
// (mcp-gateway-http §6). The header name/scheme is a Class 3 implementation
// detail (not fixed by the spec) — `Authorization: Bearer <key>` is chosen
// because it is the idiomatic HTTP credential channel and is what the MCP
// SDK's own StreamableHTTPClientTransport already sends by default when
// given a bearer token, so callers need no bespoke header support.
const CREDENTIAL_HEADER = 'authorization';
const CREDENTIAL_PREFIX = 'Bearer ';

// The HTTP route MCP traffic is served on. Also a Class 3 detail — nothing
// in the spec names a path; POST /mcp matches the SDK's own examples.
const MCP_PATH = '/mcp';

function extractCredential(req) {
  const header = req.headers[CREDENTIAL_HEADER];
  if (typeof header !== 'string' || !header.startsWith(CREDENTIAL_PREFIX)) return undefined;
  return header.slice(CREDENTIAL_PREFIX.length);
}

function sendUnauthorized(res) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'unauthorized' }));
}

function sendInternalError(res) {
  if (res.headersSent) return;
  res.writeHead(500, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    }),
  );
}

// HTTP mode: the shared secret is checked on *every* request (not once at
// launch, unlike stdio's runStdio) — a missing/invalid key gets an explicit
// HTTP 401 before the request body is parsed or the MCP layer sees it at
// all, and never affects any other in-flight or later request on the same
// process (mcp-gateway-http HTTP-AC2).
export async function runHttp(config) {
  // Connect to the backend once for the life of the process, same as
  // stdio — all HTTP requests are proxied to this single backend child
  // process (HTTP-AC1: "the same backend child process used by the stdio
  // transport").
  const backendClient = await connectBackend(config);

  const httpServer = createServer((req, res) => {
    if (req.url !== MCP_PATH) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    const credential = extractCredential(req);
    if (!keysMatch(credential, config.apiKey)) {
      sendUnauthorized(res);
      return;
    }

    // A fresh gateway Server + stateless transport per request: cheap
    // (tool listing/allowlist logic is stateless and just re-queries the
    // shared backendClient), and keeps one caller's request lifecycle from
    // ever leaking into another's on a shared process.
    const gatewayServer = buildGatewayServer({ backendClient, allowlist: config.allowlist });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close();
      gatewayServer.close();
    });

    gatewayServer
      .connect(transport)
      .then(() => transport.handleRequest(req, res))
      .catch((err) => {
        process.stderr.write(`datadog-mcp-gateway: HTTP request handling error: ${err?.stack ?? err}\n`);
        sendInternalError(res);
      });
  });

  const port = Number(config.port);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });

  return httpServer;
}
