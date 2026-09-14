#!/usr/bin/env bash
#
# headersHelper for the "datadog" MCP server entry (see
# mcp-datadog-gateway.example.json). Claude Code runs this at every
# connection attempt and expects a JSON object of headers on stdout.
#
# It ensures the shared gateway daemon is up — bootstrapping it (and
# fetching DD_API_KEY/DD_APP_KEY from 1Password) the first time only — then
# just probes and returns the bearer header. So the FIRST Claude instance to
# connect pays the container-start + 1Password cost; every instance after
# that (this one on reconnect, or any other instance already running) just
# finds the container already up and returns immediately.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_FILE="${DD_MCP_GATEWAY_KEY_FILE:-$HOME/.secrets/dd-mcp-gateway.key}"

# start is idempotent: no-op (just the docker ps probe) if the daemon is
# already running, bootstrap (1Password fetch + docker run) only if not.
"$SCRIPT_DIR/dd-mcp-gateway-daemon.sh" start >&2

printf '{"Authorization":"Bearer %s"}\n' "$(cat "$KEY_FILE")"
