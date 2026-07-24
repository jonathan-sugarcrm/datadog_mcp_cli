// Deliberately does not accept or record any caller-identity field (no
// session id, IP, user, etc.) — the gateway authenticates a shared secret,
// not an individual, so there is nothing to attribute a call to.
//
// Writes to stderr, never stdout: for the stdio transport, stdout *is* the
// MCP JSON-RPC channel (CORE-01/§6), so a log line on stdout would corrupt
// the protocol stream. stderr is unused by the protocol and safe for logs.
export function logCall({ tool, outcome, startedAt }) {
  const entry = {
    ts: new Date().toISOString(),
    tool,
    outcome, // one of: success | failure | rejected (CORE-03)
    durationMs: Date.now() - startedAt,
  };
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}
