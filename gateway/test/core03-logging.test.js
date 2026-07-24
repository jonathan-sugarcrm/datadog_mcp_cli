import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// CORE-03: exactly one log entry per tools/call outcome (success, backend
// failure, allowlist rejection), each with tool name + timestamp + outcome,
// and never containing caller identity or any of the configured secrets.
// This drives the *real* subprocess over real stdio (not an in-memory
// fixture) so the evidence covers the actual process boundary where the
// logger and the MCP transport share the same file descriptors.

const here = path.dirname(fileURLToPath(import.meta.url));
const indexPath = path.join(here, '..', 'src', 'index.js');
const mockBackend = path.join(here, 'fixtures', 'mock-datadog-server.js');

const GATEWAY_API_KEY = 'expected-secret-log-test';
const GATEWAY_CLIENT_KEY = GATEWAY_API_KEY;
const DD_API_KEY = 'dd-api-key-should-never-appear';
const DD_APP_KEY = 'dd-app-key-should-never-appear';
const CALLER_ID = 'caller-42-should-never-appear';

const SECRET_VALUES = [GATEWAY_API_KEY, GATEWAY_CLIENT_KEY, DD_API_KEY, DD_APP_KEY];

function parseLogLines(stderrText) {
  return stderrText
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
}

test('CORE-03: success, backend-failure, and rejected calls each produce exactly one clean log entry', async () => {
  const stderrChunks = [];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [indexPath],
    env: {
      ...process.env,
      GATEWAY_API_KEY,
      GATEWAY_CLIENT_KEY,
      MCP_ALLOWLIST: 'search_logs,always_fails',
      BACKEND_COMMAND: process.execPath,
      BACKEND_ARGS: mockBackend,
      DD_API_KEY,
      DD_APP_KEY,
      // Passed only to prove the logger never echoes a caller-identity
      // field; the gateway itself has no notion of caller identity.
      CALLER_ID,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '0.0.1' });

  transport.stderr.setEncoding('utf8');
  transport.stderr.on('data', (chunk) => stderrChunks.push(chunk));

  try {
    await client.connect(transport, { timeout: 5000 });

    // 1. success
    await client.callTool({ name: 'search_logs', arguments: {} });
    // 2. backend failure (forwarded call, backend itself throws)
    await assert.rejects(() => client.callTool({ name: 'always_fails', arguments: {} }));
    // 3. allowlist rejection (never reaches the backend)
    await assert.rejects(() => client.callTool({ name: 'delete_monitor', arguments: {} }));
  } finally {
    await transport.close();
  }

  // Give the child process's stderr stream a tick to flush fully.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const rawStderr = stderrChunks.join('');
  const entries = parseLogLines(rawStderr);

  // Print the raw evidence to stdout: this is what makes the row in the
  // implementation handoff's evidence bundle reproducible rather than a
  // bare "ok 1" claim — `node --test test/core03-logging.test.js` on its
  // own reproduces these exact lines.
  console.log('--- raw captured stderr (verbatim gateway log output) ---');
  console.log(rawStderr);
  const secretScan = SECRET_VALUES.concat(CALLER_ID).map(
    (value) => `${value}: ${rawStderr.includes(value) ? 'MATCH' : 'no match'}`,
  );
  console.log('--- secret/caller-identity scan over the raw output above ---');
  console.log(secretScan.join('\n'));

  const byOutcome = (outcome) => entries.filter((e) => e.outcome === outcome);

  assert.equal(byOutcome('success').length, 1, `expected exactly one success entry, got: ${rawStderr}`);
  assert.equal(byOutcome('failure').length, 1, `expected exactly one failure entry, got: ${rawStderr}`);
  assert.equal(byOutcome('rejected').length, 1, `expected exactly one rejected entry, got: ${rawStderr}`);

  for (const entry of [byOutcome('success')[0], byOutcome('failure')[0], byOutcome('rejected')[0]]) {
    assert.ok(typeof entry.tool === 'string' && entry.tool.length > 0, 'tool name present');
    assert.ok(typeof entry.ts === 'string' && entry.ts.length > 0, 'timestamp present');
    assert.ok(!Number.isNaN(Date.parse(entry.ts)), 'timestamp is a real ISO-8601 date');
    assert.ok(['success', 'failure', 'rejected'].includes(entry.outcome), 'outcome present and valid');
  }

  assert.equal(byOutcome('success')[0].tool, 'search_logs');
  assert.equal(byOutcome('failure')[0].tool, 'always_fails');
  assert.equal(byOutcome('rejected')[0].tool, 'delete_monitor');

  // No caller-identity field, and none of the secret literal values appear
  // anywhere in the raw log output, for any of the three outcomes.
  for (const value of SECRET_VALUES) {
    assert.doesNotMatch(rawStderr, new RegExp(value), `secret value "${value}" must never appear in logs`);
  }
  assert.doesNotMatch(rawStderr, new RegExp(CALLER_ID), 'caller-identity value must never appear in logs');
  // Assert the exact field set rather than blocklisting a few guessed
  // caller-identity field names — this proves "no caller-identifying field
  // of any name" (CORE-03), not just the ones this test happened to think of.
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['durationMs', 'outcome', 'ts', 'tool'].sort());
  }
});
