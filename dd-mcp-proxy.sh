#!/usr/bin/env bash
#
# Launches the hardened datadog_mcp_cli container as an MCP stdio server,
# authenticating with Datadog API keys (no interactive OAuth).
#
# Secrets are pulled live from 1Password — no plaintext secrets file on
# disk. Only the two Datadog keys are forwarded into the container.
#
set -euo pipefail

IMAGE="${DD_MCP_IMAGE:-datadog_mcp_cli:hardened}"
DD_SITE="${DD_SITE:-us1}"   # one of: us1 eu1 us3 us5 ap1 ap2 staging

DD_API_KEY_REF="${DD_API_KEY_REF:-op://Employee/DATADOG_API/DD_API_KEY}"
DD_APP_KEY_REF="${DD_APP_KEY_REF:-op://Employee/DATADOG_API/DD_APP_KEY}"

# Temporary diagnostic logging. TODO: remove once root-caused.
DEBUG_LOG="${DD_MCP_DEBUG_LOG:-$HOME/.local/state/dd-mcp-proxy-debug.log}"
mkdir -p "$(dirname "$DEBUG_LOG")" 2>/dev/null || true
log() { printf '%s [pid %s] %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$$" "$1" >>"$DEBUG_LOG" 2>/dev/null || true; }

log "start: HOME=$HOME PWD=$(pwd) USER=${USER:-unset}"
log "PATH=$PATH"
log "argv: $0 $*"

if command -v op >/dev/null 2>&1; then
  OP_BIN="op"
elif command -v op.exe >/dev/null 2>&1; then
  OP_BIN="op.exe"
else
  log "error: op/op.exe not found"
  echo "dd-mcp-proxy: 1Password CLI ('op' or 'op.exe') not found in PATH" >&2
  exit 1
fi
log "using OP_BIN=$OP_BIN ($(command -v "$OP_BIN"))"

op_read_retry() {
  local ref="$1" attempt out
  for attempt in 1 2 3; do
    if out="$("$OP_BIN" read "$ref" 2>&1)"; then
      printf '%s' "$out"
      return 0
    fi
    log "op read failed (attempt $attempt/3) for $ref: $out"
    echo "dd-mcp-proxy: op read failed (attempt $attempt/3) for $ref: $out" >&2
    sleep 1
  done
  return 1
}

log "resolving DD_API_KEY"
DD_API_KEY="$(op_read_retry "$DD_API_KEY_REF")"
log "resolved DD_API_KEY len=${#DD_API_KEY}"

log "resolving DD_APP_KEY"
DD_APP_KEY="$(op_read_retry "$DD_APP_KEY_REF")"
log "resolved DD_APP_KEY len=${#DD_APP_KEY}"

export DD_API_KEY DD_APP_KEY

log "docker version: $(docker --version 2>&1)"
log "launching docker run (pids-limit=512)"
docker run --rm -i \
  --env DD_API_KEY \
  --env DD_APP_KEY \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=256m \
  "$IMAGE" --site "$DD_SITE" "$@"
STATUS=$?
log "docker run exited: $STATUS"
exit "$STATUS"
