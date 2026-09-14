#!/usr/bin/env bash
#
# stdio entry point for the "datadog" MCP server. Claude Code's HTTP
# transport attempts OAuth Dynamic Client Registration on its first request
# regardless of headersHelper (upstream gap: anthropics/claude-code#3273,
# #26675), so a plain http+headersHelper config never gets past the
# handshake. This script sidesteps that entirely by keeping the client-
# facing transport as stdio (which Claude Code just execs, no auth
# negotiation of its own) and bridging stdio<->HTTP itself via `mcp-remote`,
# talking to the shared gateway daemon with a plain bearer header.
#
# Bootstrap-then-probe is preserved: the daemon script it calls is
# idempotent, so the FIRST Claude instance to launch this pays the
# container-start + 1Password cost, every instance after that just finds
# the container already running.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${DD_MCP_GATEWAY_PORT:-8791}"
KEY_FILE="${DD_MCP_GATEWAY_KEY_FILE:-$HOME/.secrets/dd-mcp-gateway.key}"

"$SCRIPT_DIR/dd-mcp-gateway-daemon.sh" start >&2

HEADER_FILE="$(mktemp)"
trap 'rm -f "$HEADER_FILE"' EXIT
( umask 177; printf 'Authorization: Bearer %s\n' "$(cat "$KEY_FILE")" > "$HEADER_FILE" )

# Not exec'd: the EXIT trap must still fire (to remove the header file)
# once mcp-remote exits. stdio is inherited either way, so nothing is lost
# by running it as a plain foreground child instead of exec'ing it.
npx -y mcp-remote "http://127.0.0.1:${PORT}/mcp" --header-file "$HEADER_FILE"
