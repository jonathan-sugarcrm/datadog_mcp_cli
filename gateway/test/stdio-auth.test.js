import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, '..', 'src', 'index.js');
const mockBackend = path.join(here, 'fixtures', 'mock-datadog-server.js');

// Bounded timeout for the failure-path assertions (CORE-01 verification
// method requires the failure to be observable "within a bounded timeout").
const BOUNDED_TIMEOUT_MS = 5_000;

// The marker path travels as a CLI arg to the mock backend (`BACKEND_ARGS`),
// not an env var: the gateway's connectBackend() only forwards a narrow,
// explicit env allowlist to the real backend process (DD_API_KEY/DD_APP_KEY/
// DD_SITE + SDK defaults — see gateway.js `backendEnv`), so a test-only env
// var like MOCK_MARKER_FILE would never reach the child either way.
function backendArgsWithMarker(marker) {
  return `${mockBackend} ${marker}`;
}

function runGateway(env) {
  return execFileSync(process.execPath, [indexPath], {
    input: '',
    env: { ...process.env, BACKEND_COMMAND: process.execPath, BACKEND_ARGS: mockBackend, ...env },
    encoding: 'utf8',
    timeout: BOUNDED_TIMEOUT_MS,
  });
}

test('stdio mode refuses to start the backend when the client key is missing', () => {
  const marker = path.join(tmpdir(), `dd-gw-marker-${process.pid}-1`);
  rmSync(marker, { force: true });

  assert.throws(() =>
    runGateway({ GATEWAY_API_KEY: 'expected-secret', BACKEND_ARGS: backendArgsWithMarker(marker) }),
  );
  assert.equal(existsSync(marker), false, 'backend must never be spawned without a valid client key');
});

test('stdio mode refuses to start the backend when the client key is wrong', () => {
  const marker = path.join(tmpdir(), `dd-gw-marker-${process.pid}-2`);
  rmSync(marker, { force: true });

  assert.throws(() =>
    runGateway({
      GATEWAY_API_KEY: 'expected-secret',
      GATEWAY_CLIENT_KEY: 'wrong-secret',
      BACKEND_ARGS: backendArgsWithMarker(marker),
    }),
  );
  assert.equal(existsSync(marker), false, 'backend must never be spawned with an invalid client key');
});

test('stdio mode never answers an MCP request when the client key is missing or wrong', async () => {
  // Drive a real MCP client against the real gateway subprocess. If the
  // key check failed to gate the transport, connect() (which performs the
  // MCP initialize handshake) would resolve; instead the process must exit
  // before ever answering, so connect() must reject/timeout.
  const marker = path.join(tmpdir(), `dd-gw-marker-${process.pid}-3`);
  rmSync(marker, { force: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [indexPath],
    env: {
      ...process.env,
      GATEWAY_API_KEY: 'expected-secret',
      GATEWAY_CLIENT_KEY: 'wrong-secret',
      BACKEND_COMMAND: process.execPath,
      BACKEND_ARGS: backendArgsWithMarker(marker),
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });

  await assert.rejects(
    () => client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS }),
    'no MCP response — including the initialize handshake — is ever given without a valid key',
  );
  assert.equal(existsSync(marker), false, 'backend must never be spawned without a valid client key');
});

test('stdio mode connects to the backend and answers tools/list when the client key matches', async () => {
  const marker = path.join(tmpdir(), `dd-gw-marker-${process.pid}-4`);
  rmSync(marker, { force: true });

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [indexPath],
    env: {
      ...process.env,
      GATEWAY_API_KEY: 'expected-secret',
      GATEWAY_CLIENT_KEY: 'expected-secret',
      BACKEND_COMMAND: process.execPath,
      BACKEND_ARGS: backendArgsWithMarker(marker),
    },
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });

  try {
    await client.connect(transport, { timeout: BOUNDED_TIMEOUT_MS });
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, 'tools/list got a real response from the proxied backend');
    assert.equal(existsSync(marker), true, 'backend child process was spawned');
  } finally {
    await transport.close();
  }
});
