#!/usr/bin/env node
// Stands in for the real `datadog_mcp_cli` binary in tests: an MCP stdio
// server exposing a small fixed set of fake tools. If a marker-file path is
// given as the first CLI arg (not an env var — the gateway only forwards a
// narrow env allowlist to the real backend, see gateway.js `backendEnv`),
// it writes a marker on startup so tests can assert whether the backend
// was ever actually invoked.
import { writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const markerFile = process.argv[2];
if (markerFile) {
  writeFileSync(markerFile, 'invoked');
}

const TOOLS = [
  { name: 'search_logs', description: 'Search Datadog logs', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_metric', description: 'Fetch a Datadog metric', inputSchema: { type: 'object', properties: {} } },
  { name: 'delete_monitor', description: 'Delete a Datadog monitor', inputSchema: { type: 'object', properties: {} } },
  // Deliberately always throws, so tests can exercise the "backend call
  // itself errors" failure behaviour (CORE-02/CORE-03) without depending on
  // real Datadog network access.
  { name: 'always_fails', description: 'Always errors, for tests', inputSchema: { type: 'object', properties: {} } },
];

const server = new Server({ name: 'mock-datadog', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'always_fails') {
    throw new Error('simulated backend failure');
  }
  return { content: [{ type: 'text', text: `called:${request.params.name}` }] };
});

await server.connect(new StdioServerTransport());
