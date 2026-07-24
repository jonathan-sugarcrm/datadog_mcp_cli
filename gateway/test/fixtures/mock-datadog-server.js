#!/usr/bin/env node
// Stands in for the real `datadog_mcp_cli` binary in tests: an MCP stdio
// server exposing a small fixed set of fake tools. If a marker-file path is
// given as the first CLI arg (not an env var — the gateway only forwards a
// narrow env allowlist to the real backend, see gateway.js `backendEnv`),
// it writes a marker on startup so tests can assert whether the backend
// was ever actually invoked.
//
// A second, optional CLI arg names a "calls log" file: every tools/call
// this backend actually receives appends one line (the tool name) to that
// file. This is the only way an HTTP test process — which only talks to
// the gateway subprocess over a socket, never to this backend directly —
// can observe "backend invocation count" from outside (HTTP-AC1/AC2/AC3
// verification methods all key on that count).
import { appendFileSync, writeFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const markerFile = process.argv[2];
if (markerFile) {
  writeFileSync(markerFile, 'invoked');
}

const callsLogFile = process.argv[3];

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
  if (callsLogFile) {
    appendFileSync(callsLogFile, `${request.params.name}\n`);
  }
  if (request.params.name === 'always_fails') {
    throw new Error('simulated backend failure');
  }
  return { content: [{ type: 'text', text: `called:${request.params.name}` }] };
});

await server.connect(new StdioServerTransport());
