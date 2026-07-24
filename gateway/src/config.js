// mcp-gateway-core is stdio-only (CORE-01..03); HTTP transport / per-request
// header auth is a different slice (mcp-gateway-http) and is out of scope
// here, so this config has no transport switch.
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
    // starts (CORE-01).
    clientKey: env.GATEWAY_CLIENT_KEY,
    allowlist,
    backendCommand: env.BACKEND_COMMAND ?? 'datadog_mcp_cli',
    backendArgs: env.BACKEND_ARGS
      ? env.BACKEND_ARGS.split(' ').filter(Boolean)
      : ['--site', env.DD_SITE ?? 'us1'],
  };
}
