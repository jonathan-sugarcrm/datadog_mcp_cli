import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildGatewayServer } from '../src/gateway.js';

const FAKE_TOOLS = [
  { name: 'search_logs', description: 'search', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_monitor', description: 'delete', inputSchema: { type: 'object', properties: {} } },
  { name: 'always_fails', description: 'always errors', inputSchema: { type: 'object', properties: {} } },
];

async function startFakeBackend() {
  const server = new Server({ name: 'fake-datadog', version: '0.0.1' }, { capabilities: { tools: {} } });
  const calls = [];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: FAKE_TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    calls.push(request.params.name);
    if (request.params.name === 'always_fails') {
      throw new Error('simulated backend failure');
    }
    return { content: [{ type: 'text', text: `called:${request.params.name}` }] };
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const backendClient = new Client({ name: 'test-backend-client', version: '0.0.1' });
  await backendClient.connect(clientTransport);

  return { backendClient, calls };
}

async function connectExternalClient(gatewayServer) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gatewayServer.connect(serverTransport);
  const client = new Client({ name: 'test-external-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

test('gateway with no allowlist exposes every backend tool', async () => {
  const { backendClient } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: null });
  const client = await connectExternalClient(gatewayServer);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['always_fails', 'delete_monitor', 'search_logs']);
});

test('gateway with an allowlist hides non-allowlisted tools from listTools', async () => {
  const { backendClient } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: new Set(['search_logs']) });
  const client = await connectExternalClient(gatewayServer);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search_logs']);
});

test('an allowlisted tool call is forwarded to the backend', async () => {
  const { backendClient, calls } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: new Set(['search_logs']) });
  const client = await connectExternalClient(gatewayServer);

  const result = await client.callTool({ name: 'search_logs', arguments: {} });
  assert.deepEqual(calls, ['search_logs']);
  assert.equal(result.content[0].text, 'called:search_logs');
});

test('a non-allowlisted tool call is rejected without reaching the backend', async () => {
  const { backendClient, calls } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: new Set(['search_logs']) });
  const client = await connectExternalClient(gatewayServer);

  await assert.rejects(() => client.callTool({ name: 'delete_monitor', arguments: {} }));
  assert.deepEqual(calls, [], 'backend must never see the rejected call');
});

test('tools/list is stable across repeated calls in one run (CORE-02a)', async () => {
  const { backendClient } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: new Set(['search_logs']) });
  const client = await connectExternalClient(gatewayServer);

  const first = await client.listTools();
  // An unrelated call in between, then list again.
  await client.callTool({ name: 'search_logs', arguments: {} });
  const second = await client.listTools();

  const names = (r) => r.tools.map((t) => t.name).sort();
  assert.deepEqual(names(first), ['search_logs']);
  assert.deepEqual(names(second), ['search_logs']);
  assert.deepEqual(names(first), names(second));
});

test('when a forwarded call errors on the backend, the gateway relays the error rather than fabricating success', async () => {
  const { backendClient, calls } = await startFakeBackend();
  const gatewayServer = buildGatewayServer({ backendClient, allowlist: new Set(['always_fails']) });
  const client = await connectExternalClient(gatewayServer);

  await assert.rejects(
    () => client.callTool({ name: 'always_fails', arguments: {} }),
    /simulated backend failure/,
  );
  assert.deepEqual(calls, ['always_fails'], 'backend was actually invoked for an allowed tool');
});
