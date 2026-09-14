#!/usr/bin/env bash
#
# Starts the datadog-mcp-gateway as a single, long-lived HTTP daemon that
# every local MCP client (every Claude Code/Desktop instance) shares.
#
# Unlike dd-mcp-proxy.sh (which every MCP client spawns as its own stdio
# subprocess, so every session re-fetches DD_API_KEY/DD_APP_KEY from
# 1Password), this script fetches those secrets ONCE and hands them to a
# single background container. Clients then talk to it over
# http://127.0.0.1:$PORT/mcp with a bearer token instead of launching
# anything themselves — no more per-session 1Password round trips.
#
# Usage:
#   ./dd-mcp-gateway-daemon.sh start     # idempotent: no-op if already running
#   ./dd-mcp-gateway-daemon.sh restart   # re-fetch secrets, replace the container
#   ./dd-mcp-gateway-daemon.sh stop
#   ./dd-mcp-gateway-daemon.sh status
#
set -euo pipefail

ACTION="${1:-start}"

IMAGE="${DD_MCP_GATEWAY_IMAGE:-datadog-mcp-gateway:latest}"
CONTAINER_NAME="${DD_MCP_GATEWAY_CONTAINER:-dd-mcp-gateway}"
PORT="${DD_MCP_GATEWAY_PORT:-8791}"
DD_SITE="${DD_SITE:-us1}"

DD_API_KEY_REF="${DD_API_KEY_REF:-op://Employee/DATADOG_API/DD_API_KEY}"
DD_APP_KEY_REF="${DD_APP_KEY_REF:-op://Employee/DATADOG_API/DD_APP_KEY}"

# The shared bearer token every client config presents. Generated once and
# reused across restarts (so client configs don't have to change every time
# the daemon restarts); it never leaves this machine.
KEY_FILE="${DD_MCP_GATEWAY_KEY_FILE:-$HOME/.secrets/dd-mcp-gateway.key}"

status() {
  if docker ps --filter "name=^/${CONTAINER_NAME}$" --filter status=running -q | grep -q .; then
    echo "dd-mcp-gateway: running (container '$CONTAINER_NAME', port $PORT)"
    return 0
  fi
  echo "dd-mcp-gateway: not running"
  return 1
}

stop() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  echo "dd-mcp-gateway: stopped"
}

ensure_gateway_key() {
  if [ -s "$KEY_FILE" ]; then
    return
  fi
  install -d -m 0700 "$(dirname "$KEY_FILE")"
  ( umask 177; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$KEY_FILE" )
  echo "dd-mcp-gateway: generated a new shared gateway key at $KEY_FILE" >&2
}

# Same op-invocation hardening as dd-mcp-proxy.sh: stdin must never be the
# caller's own stdin (this script isn't proxying an MCP stdio pipe itself,
# but op still shouldn't inherit an unrelated terminal/pipe), and both keys
# are fetched in a single `op inject` round trip rather than two `op read`
# calls. This only runs once per daemon start/restart, not once per client.
fetch_datadog_keys() {
  if command -v op >/dev/null 2>&1; then
    OP_BIN="op"
  elif command -v op.exe >/dev/null 2>&1; then
    OP_BIN="op.exe"
  else
    echo "dd-mcp-gateway: 1Password CLI ('op' or 'op.exe') not found in PATH" >&2
    exit 1
  fi

  local template="DD_API_KEY=${DD_API_KEY_REF}
DD_APP_KEY=${DD_APP_KEY_REF}"
  local attempt out
  for attempt in 1 2 3; do
    if out="$("$OP_BIN" inject 2>/dev/null <<<"$template")"; then
      DD_API_KEY="$(printf '%s\n' "$out" | sed -n 's/^DD_API_KEY=//p')"
      DD_APP_KEY="$(printf '%s\n' "$out" | sed -n 's/^DD_APP_KEY=//p')"
      export DD_API_KEY DD_APP_KEY
      return 0
    fi
    echo "dd-mcp-gateway: op inject failed (attempt $attempt/3)" >&2
    sleep 1
  done
  echo "dd-mcp-gateway: could not fetch Datadog keys from 1Password" >&2
  exit 1
}

start() {
  if status >/dev/null 2>&1; then
    echo "dd-mcp-gateway: already running (container '$CONTAINER_NAME'); use 'restart' to refresh credentials"
    return 0
  fi

  ensure_gateway_key
  local gateway_key
  gateway_key="$(cat "$KEY_FILE")"

  fetch_datadog_keys

  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

  docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    -p "127.0.0.1:${PORT}:${PORT}" \
    --env MCP_TRANSPORT=http \
    --env PORT="$PORT" \
    --env GATEWAY_API_KEY="$gateway_key" \
    --env DD_API_KEY \
    --env DD_APP_KEY \
    --env DD_SITE="$DD_SITE" \
    --read-only \
    --tmpfs /tmp:rw,noexec,nosuid,size=16m \
    --cap-drop=ALL \
    --security-opt=no-new-privileges \
    --pids-limit=128 \
    --memory=256m \
    "$IMAGE" >/dev/null

  echo "dd-mcp-gateway: started (container '$CONTAINER_NAME', http://127.0.0.1:${PORT}/mcp)"
  echo "dd-mcp-gateway: bearer token for client configs is in $KEY_FILE"
}

case "$ACTION" in
  start) start ;;
  restart) stop; start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 {start|restart|stop|status}" >&2; exit 2 ;;
esac
