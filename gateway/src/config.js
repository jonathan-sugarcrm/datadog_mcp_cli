export function loadConfig(env = process.env) {
  const apiKey = env.GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error('GATEWAY_API_KEY is required (the shared secret clients must present)');
  }

  const allowlistRaw = env.MCP_ALLOWLIST;
  const allowlist = allowlistRaw
    ? new Set(
        allowlistRaw
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      )
    : null; // null => expose every tool the backend provides

  return {
    apiKey,
    // The key the local launcher must present, checked once at startup
    // against apiKey, before the backend connection or server transport
    // starts (CORE-01). Only meaningful for the stdio transport.
    clientKey: env.GATEWAY_CLIENT_KEY,
    allowlist,
    backendCommand: env.BACKEND_COMMAND ?? 'datadog_mcp_cli',
    backendArgs: env.BACKEND_ARGS
      ? env.BACKEND_ARGS.split(' ').filter(Boolean)
      : ['--site', env.DD_SITE ?? 'us1'],
    // Selects which server transport index.js wires up (mcp-gateway-http
    // §7): 'stdio' (default) or 'http'. Any other value falls back to
    // stdio rather than silently doing nothing.
    transport: env.MCP_TRANSPORT === 'http' ? 'http' : 'stdio',
    // HTTP listen port (HTTP transport only). No default is assumed (§7
    // documents none for PORT, unlike MCP_TRANSPORT) — left as whatever the
    // caller passed, including undefined.
    port: env.PORT,
  };
}
