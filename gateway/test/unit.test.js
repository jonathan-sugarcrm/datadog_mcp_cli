import assert from 'node:assert/strict';
import test from 'node:test';
import { keysMatch } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { filterTools } from '../src/gateway.js';

test('loadConfig requires GATEWAY_API_KEY', () => {
  assert.throws(() => loadConfig({}), /GATEWAY_API_KEY/);
});

test('loadConfig defaults to no allowlist (exposes every backend tool)', () => {
  const config = loadConfig({ GATEWAY_API_KEY: 'k' });
  assert.equal(config.allowlist, null);
});

test('loadConfig parses a comma-separated allowlist', () => {
  const config = loadConfig({ GATEWAY_API_KEY: 'k', MCP_ALLOWLIST: 'search_logs, get_metric ,' });
  assert.deepEqual([...config.allowlist], ['search_logs', 'get_metric']);
});

test('keysMatch is true only for an exact, non-empty match', () => {
  assert.equal(keysMatch('secret', 'secret'), true);
  assert.equal(keysMatch('secret', 'other'), false);
  assert.equal(keysMatch('', 'secret'), false);
  assert.equal(keysMatch(undefined, 'secret'), false);
  assert.equal(keysMatch('secret', undefined), false);
});

test('filterTools returns everything when allowlist is null', () => {
  const tools = [{ name: 'a' }, { name: 'b' }];
  assert.deepEqual(filterTools(tools, null), tools);
});

test('filterTools restricts to the allowlisted names', () => {
  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
  assert.deepEqual(filterTools(tools, new Set(['a', 'c'])), [{ name: 'a' }, { name: 'c' }]);
});
