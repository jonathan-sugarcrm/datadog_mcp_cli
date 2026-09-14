#!/usr/bin/env bash
#
# Launches the hardened datadog_mcp_cli container as an MCP stdio server,
# authenticating with Datadog API keys (no interactive OAuth).
#
# Secrets are pulled live from 1Password on every launch — no plaintext
# secrets file and no secret caching. Only the two Datadog keys are
# forwarded into the container.
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

# IMPORTANT: redirect stdin to /dev/null for every op invocation. This
# script's own stdin is the MCP client's stdio pipe carrying the protocol
# messages meant for the container below. Without </dev/null, op(.exe)
# inherits and drains that pipe (confirmed: bytes written before op ran
# were gone by the time docker started reading), so the container waits
# forever for a message that already got consumed. This was the actual
# cause of every MCP connect timeout — not Docker, 1Password speed, IPv6,
# or pids-limit.
#
# Both keys are fetched in a single `op inject` call rather than two
# separate `op read` calls, so a launch costs one round trip to the
# secrets provider instead of two (up to one retried call of 3 attempts
# instead of two).
op_inject_retry() {
  local attempt out
  local template="DD_API_KEY=${DD_API_KEY_REF}
DD_APP_KEY=${DD_APP_KEY_REF}"
  for attempt in 1 2 3; do
    if out="$("$OP_BIN" inject 2>/dev/null <<<"$template")"; then
      printf '%s' "$out"
      return 0
    fi
    echo "dd-mcp-proxy: op inject failed (attempt $attempt/3)" >&2
    sleep 1
  done
  return 1
}

injected="$(op_inject_retry)"
DD_API_KEY="$(printf '%s\n' "$injected" | sed -n 's/^DD_API_KEY=//p')"
DD_APP_KEY="$(printf '%s\n' "$injected" | sed -n 's/^DD_APP_KEY=//p')"
export DD_API_KEY DD_APP_KEY

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
