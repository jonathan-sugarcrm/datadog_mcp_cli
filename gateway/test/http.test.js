import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// mcp-gateway-http: drives the real gateway subprocess over a real HTTP
// socket (MCP_TRANSPORT=http), exactly as stdio-auth.test.js drives it over
// a real stdio pipe for mcp-gateway-core. The mock backend's calls-log file
// (see fixtures/mock-datadog-server.js) is how these tests observe "backend
// invocation count" from outside both subprocesses.

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, '..', 'src', 'index.js');
const mockBackend = path.join(here, 'fixtures', 'mock-datadog-server.js');

const BOUNDED_TIMEOUT_MS = 5_000;

function freshPath(name) {
  return path.join(tmpdir(), `dd-gw-http-${process.pid}-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// Picks a free TCP port by binding to port 0 and reading back what the OS
// assigned, then releasing it immediately for the gateway subprocess to
// bind. Avoids fixed-port collisions between parallel test files.
async function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function countCalls(callsLogFile) {
  if (!existsSync(callsLogFile)) return [];
  return readFileSync(callsLogFile, 'utf8').split('\n').filter(Boolean);
}

// Starts the real gateway subprocess in HTTP mode and waits until it is
// actually accepting connections on `port` (bounded — fails the test rather
// than hanging forever if the server never comes up).
async function startHttpGateway(env) {
  const child = spawn(process.execPath, [indexPath], {
    env: { ...process.env, MCP_TRANSPORT: 'http', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const deadline = Date.now() + BOUNDED_TIMEOUT_MS;
  const port = env.PORT;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway subprocess exited early (code ${child.exitCode}); stderr:\n${stderr}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'GET' });
      return { child, getStderr: () => stderr };
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  child.kill();
  throw new Error(`gateway HTTP server on port ${port} never became reachable; stderr:\n${stderr}`);
}

function stopHttpGateway(child) {
  child.kill();
}

test('HTTP-AC2: a request with no credential gets HTTP 401 and never reaches the backend', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-1');
  const callsLog = freshPath('calls-1');
  rmSync(marker, { force: true });

  const { child, getStderr } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const bodyText = await res.text();

    console.log('--- raw HTTP response: no credential ---');
    console.log(`status: ${res.status}`);
    console.log(`body: ${bodyText}`);

    assert.equal(res.status, 401);
    assert.equal(existsSync(marker), true, 'backend process itself was spawned at gateway startup');
    assert.deepEqual(countCalls(callsLog), [], 'backend must never receive a tools/call without a credential');
  } finally {
    stopHttpGateway(child);
    void getStderr;
  }
});

test('HTTP-AC2: a request with a mismatched credential gets HTTP 401 and never reaches the backend', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-2');
  const callsLog = freshPath('calls-2');
  rmSync(marker, { force: true });

  const { child } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const bodyText = await res.text();

    console.log('--- raw HTTP response: mismatched credential ---');
    console.log(`status: ${res.status}`);
    console.log(`body: ${bodyText}`);

    assert.equal(res.status, 401);
    assert.deepEqual(countCalls(callsLog), [], 'backend must never receive a tools/call with a wrong credential');
  } finally {
    stopHttpGateway(child);
  }
});

test('HTTP-AC2: rejection of one request does not affect a later valid request on the same process', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-3');
  const callsLog = freshPath('calls-3');
  rmSync(marker, { force: true });

  const { child } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    MCP_ALLOWLIST: 'get_metric',
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    // (a) no credential
    const noCred = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(noCred.status, 401);
    assert.deepEqual(countCalls(callsLog), []);

    // (b) mismatched credential
    const badCred = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(badCred.status, 401);
    assert.deepEqual(countCalls(callsLog), [], 'backend invocation count is still zero after two rejections');

    // (c) valid credential, allowlisted tool call — same running process.
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer expected-secret' } },
    });
    const client = new Client({ name: 'http-ac2-client', version: '0.0.1' });
    await client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS });
    const result = await client.callTool({ name: 'get_metric', arguments: {} });
    await transport.close();

    console.log('--- raw evidence: valid call after two rejections ---');
    console.log(JSON.stringify(result));
    console.log(`calls-log contents after (c): ${JSON.stringify(countCalls(callsLog))}`);

    assert.equal(result.content[0].text, 'called:get_metric');
    assert.deepEqual(countCalls(callsLog), ['get_metric'], 'backend invocation count increased by exactly 1');
  } finally {
    stopHttpGateway(child);
  }
});

test('HTTP-AC1: a valid, allowlisted HTTP call is forwarded and the response is structurally identical to the backend\'s own', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-4');
  const callsLog = freshPath('calls-4');
  rmSync(marker, { force: true });

  // Reference response: call the mock backend directly over stdio, with no
  // gateway in between, for the same tool + arguments.
  const directTransport = new StdioClientTransport({ command: process.execPath, args: [mockBackend] });
  const directClient = new Client({ name: 'direct-backend-client', version: '0.0.1' });
  await directClient.connect(directTransport, { timeout: BOUNDED_TIMEOUT_MS });
  const directResult = await directClient.callTool({ name: 'get_metric', arguments: {} });
  await directTransport.close();

  const { child } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    MCP_ALLOWLIST: 'get_metric',
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer expected-secret' } },
    });
    const client = new Client({ name: 'http-ac1-client', version: '0.0.1' });
    await client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS });
    const gatewayResult = await client.callTool({ name: 'get_metric', arguments: {} });
    await transport.close();

    console.log('--- raw evidence: direct-backend response vs gateway-over-HTTP response ---');
    console.log(`direct:  ${JSON.stringify(directResult)}`);
    console.log(`gateway: ${JSON.stringify(gatewayResult)}`);
    console.log(`calls-log: ${JSON.stringify(countCalls(callsLog))}`);

    assert.deepEqual(gatewayResult, directResult, 'HTTP-proxied response must be structurally identical to the backend\'s own response');
    assert.deepEqual(countCalls(callsLog), ['get_metric'], 'backend invocation count is exactly 1');
  } finally {
    stopHttpGateway(child);
  }
});

test('HTTP-AC3: a disallowed tool call over HTTP is rejected with a standard MCP/JSON-RPC error, backend never invoked', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-5');
  const callsLog = freshPath('calls-5');
  rmSync(marker, { force: true });

  const { child } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    MCP_ALLOWLIST: 'get_metric',
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer expected-secret' } },
    });
    const client = new Client({ name: 'http-ac3a-client', version: '0.0.1' });
    await client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS });

    let caught;
    try {
      await client.callTool({ name: 'delete_monitor', arguments: {} });
    } catch (err) {
      caught = err;
    }
    await transport.close();

    console.log('--- raw evidence: disallowed tool call error ---');
    console.log(JSON.stringify(caught, Object.getOwnPropertyNames(caught ?? {})));
    console.log(`calls-log: ${JSON.stringify(countCalls(callsLog))}`);

    assert.ok(caught, 'the disallowed call must reject');
    // Standard MCP/JSON-RPC error object: code + message field, not a
    // bespoke HTTP-transport-specific shape.
    assert.ok(typeof caught.code === 'number', 'error has a JSON-RPC error code');
    assert.ok(typeof caught.message === 'string' && caught.message.length > 0, 'error has a message');
    assert.deepEqual(countCalls(callsLog), [], 'backend invocation count must remain exactly zero');
  } finally {
    stopHttpGateway(child);
  }
});

test('HTTP-AC3: tools/list returns the same allowlist-filtered set on every call for the life of the process', async () => {
  const port = await getFreePort();
  const marker = freshPath('marker-6');
  const callsLog = freshPath('calls-6');
  rmSync(marker, { force: true });

  const { child } = await startHttpGateway({
    GATEWAY_API_KEY: 'expected-secret',
    PORT: String(port),
    MCP_ALLOWLIST: 'get_metric,search_logs',
    BACKEND_COMMAND: process.execPath,
    BACKEND_ARGS: `${mockBackend} ${marker} ${callsLog}`,
  });

  try {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer expected-secret' } },
    });
    const client = new Client({ name: 'http-ac3b-client', version: '0.0.1' });
    await client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS });

    const first = await client.listTools();
    await client.callTool({ name: 'get_metric', arguments: {} }); // unrelated allowed call in between
    const second = await client.listTools();
    await transport.close();

    const names = (r) => r.tools.map((t) => t.name).sort();

    console.log('--- raw evidence: tools/list called twice, unrelated call in between ---');
    console.log(`first:  ${JSON.stringify(names(first))}`);
    console.log(`second: ${JSON.stringify(names(second))}`);

    assert.deepEqual(names(first), ['get_metric', 'search_logs']);
    assert.deepEqual(names(second), ['get_metric', 'search_logs']);
    assert.deepEqual(names(first), names(second));
  } finally {
    stopHttpGateway(child);
  }
});
