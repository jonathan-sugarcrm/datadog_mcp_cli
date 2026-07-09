#!/usr/bin/env bash
#
# Launches the hardened datadog_mcp_cli container as an MCP stdio server,
# authenticating with Datadog API keys (no interactive OAuth).
#
# Secrets are read from a KEY=VALUE file (default ~/.secrets/dd_api.env) but
# ONLY the two Datadog keys are forwarded into the container — any other
# secrets that might be in the file are deliberately NOT passed through.
#
set -euo pipefail

IMAGE="${DD_MCP_IMAGE:-datadog_mcp_cli:hardened}"
SECRETS_FILE="${DD_SECRETS_FILE:-$HOME/.secrets/dd_api.env}"
DD_SITE="${DD_SITE:-us1}"   # one of: us1 eu1 us3 us5 ap1 ap2 staging

[ -r "$SECRETS_FILE" ] || { echo "dd-mcp-proxy: cannot read secrets file: $SECRETS_FILE" >&2; exit 1; }

# Load the secrets file into this script's environment, then forward only the
# Datadog keys by NAME (-e NAME), so values never appear on the command line.
set -a
# shellcheck disable=SC1090
. "$SECRETS_FILE"
set +a

: "${DD_API_KEY:?dd-mcp-proxy: DD_API_KEY not set in $SECRETS_FILE}"
: "${DD_APP_KEY:?dd-mcp-proxy: DD_APP_KEY not set in $SECRETS_FILE}"

exec docker run --rm -i \
  --env DD_API_KEY \
  --env DD_APP_KEY \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=128 \
  --memory=256m \
  "$IMAGE" --site "$DD_SITE" "$@"
