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

if command -v op >/dev/null 2>&1; then
  OP_BIN="op"
elif command -v op.exe >/dev/null 2>&1; then
  # WSL: 1Password CLI is only installed on the Windows side. `op.exe run`
  # would exec the child process in Windows, not WSL, so it can't be used
  # to wrap `docker run` — instead just read the two secret values with it.
  OP_BIN="op.exe"
else
  echo "dd-mcp-proxy: 1Password CLI ('op' or 'op.exe') not found in PATH" >&2
  exit 1
fi

# The desktop-app integration `op.exe` talks to over IPC is intermittently
# flaky (transient 504s from its local client), so retry a few times before
# giving up.
op_read_retry() {
  local ref="$1" attempt out
  for attempt in 1 2 3; do
    if out="$("$OP_BIN" read "$ref" 2>&1)"; then
      printf '%s' "$out"
      return 0
    fi
    echo "dd-mcp-proxy: op read failed (attempt $attempt/3) for $ref: $out" >&2
    sleep 1
  done
  return 1
}

DD_API_KEY="$(op_read_retry "$DD_API_KEY_REF")"
DD_APP_KEY="$(op_read_retry "$DD_APP_KEY_REF")"
export DD_API_KEY DD_APP_KEY

# pids-limit must stay well above 128: the binary's async runtime spawns
# enough OS threads under load that 128 causes thread creation to silently
# stall the process (observed hanging past 55s with no error and no
# outbound connection ever attempted).
exec docker run --rm -i \
  --env DD_API_KEY \
  --env DD_APP_KEY \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=512 \
  --memory=256m \
  "$IMAGE" --site "$DD_SITE" "$@"
