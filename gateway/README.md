# datadog-mcp-gateway — packaging

A shared-secret MCP gateway that proxies a subset of Datadog MCP tools using
a centrally held Datadog credential. It connects to the real
`datadog_mcp_cli` binary as an MCP **child process** over stdio, and exposes
itself to callers over either transport `MCP_TRANSPORT` selects:

- **stdio** (default) — for a local Docker-launched MCP client, e.g. Claude
  Desktop/Code.
- **http** — for a standalone/hosted deployment behind any host's own
  secret-injection mechanism.

**The same image, unmodified, serves both cases.** Nothing about the build
or the image differs between them — only environment variables
(`MCP_TRANSPORT`, `PORT`) and how secrets reach the container change. There
is no cloud platform, host, or provider named anywhere below: selecting and
provisioning a specific hosting platform is out of scope for this repo (see
`docs/SPECIFICATION.md` §3.2) — "standalone HTTP" here means "runs this same
container, listening on a port, wherever you point `docker run` (or your
host's container runtime) at it."

## Building the image

```sh
docker build -t datadog-mcp-gateway:latest -f gateway/Dockerfile gateway
```

This is a multi-stage build:

1. **`downloader`** — fetches the same pinned-SHA256 `datadog_mcp_cli`
   binary the repo-root `Dockerfile` embeds (direct download + `sha256sum
   --check --strict`, never `curl | bash`). A SHA-256 mismatch aborts the
   build; an unsupported `TARGETARCH` exits non-zero with a message. There
   is no "missing build arg" failure — every `ARG` (`BASE_IMAGE`,
   `DOWNLOAD_BASE_URL`, `SHA256_AMD64`/`SHA256_ARM64`) carries a default, the
   same as the root `Dockerfile`.
2. **`node-deps`** — `npm ci --omit=dev` against the committed lockfile.
3. **`runtime`** — copies the verified binary plus the app's
   `node_modules`/`src` into a minimal, non-root image (the `node` user
   already shipped by the base `node:*-bookworm-slim` image).

`docker build` exits `0` and leaves you a runnable, tagged image on success.

## Running locally over stdio

Local/Docker mode is the default transport (`MCP_TRANSPORT` unset, or
explicitly `stdio`). The launcher (your MCP client) must present
`GATEWAY_CLIENT_KEY` matching the gateway's own `GATEWAY_API_KEY` before the
gateway will connect to the Datadog backend or serve any MCP traffic — this
check happens once, at startup, before anything else.

Create an env file (analogous to `dd-mcp-proxy.sh`'s `~/.secrets/dd_api.env`
pattern — load then forward only the named keys the gateway/backend need):

```sh
# ~/.secrets/dd-mcp-gateway.env
GATEWAY_API_KEY=<a long random shared secret>
GATEWAY_CLIENT_KEY=<same value as GATEWAY_API_KEY>
DD_API_KEY=<your Datadog API key>
DD_APP_KEY=<your Datadog application key>
DD_SITE=us1
```

Run the container attached over stdio, matching `dd-mcp-proxy.sh`'s
hardening flags:

```sh
docker run --rm -i \
  --env-file ~/.secrets/dd-mcp-gateway.env \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  --pids-limit=128 \
  --memory=256m \
  datadog-mcp-gateway:latest
```

Point an MCP client at that command (mirrors `mcp-datadog.example.json`'s
shape — the client launches the container itself as its MCP server
subprocess):

```json
{
  "mcpServers": {
    "datadog-gateway": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/home/you/.secrets/dd-mcp-gateway.env",
        "--read-only",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=128",
        "--memory=256m",
        "datadog-mcp-gateway:latest"
      ]
    }
  }
}
```

### Failure behaviour (stdio)

- **Build-time:** a pinned-SHA256 mismatch aborts the build via
  `sha256sum --check --strict`; an unsupported `TARGETARCH` exits non-zero
  with a message. There is no "missing build arg" failure mode — don't
  expect one.
- **Run-time:** a missing `GATEWAY_API_KEY`, or a missing/mismatched
  `GATEWAY_CLIENT_KEY`, means the process **never serves any MCP traffic**.
  It exits non-zero with the error on stderr only — stdout, the reserved
  JSON-RPC channel, stays empty. An MCP client's `initialize` handshake
  will reject/timeout rather than ever completing.

## Running standalone over HTTP

Same image, no rebuild. Set `MCP_TRANSPORT=http` and `PORT`, and inject
secrets however your host does it (a platform secret store, an orchestrator's
env-injection, `--env-file`, etc. — anything that ultimately sets the same
environment variables below is equivalent; this repo does not prescribe
which):

```sh
docker run --rm \
  -e GATEWAY_API_KEY=<shared secret> \
  -e MCP_TRANSPORT=http \
  -e PORT=8080 \
  -e DD_API_KEY=<your Datadog API key> \
  -e DD_APP_KEY=<your Datadog application key> \
  -e DD_SITE=us1 \
  -p 8080:8080 \
  datadog-mcp-gateway:latest
```

Over HTTP, the shared secret travels per-request as
`Authorization: Bearer <GATEWAY_API_KEY>` — there is no separate
`GATEWAY_CLIENT_KEY` step, since there is no single "launch" moment to gate
the way stdio has. Every request to `POST /mcp` is checked independently.

```sh
curl -i -X POST http://<host>:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <shared secret>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-client","version":"0.0.1"}}}'
```

Verifying "same image, only secret injection differs": build once, then
confirm the digest is identical between the stdio run and the HTTP run:

```sh
docker inspect --format '{{.Id}}' datadog-mcp-gateway:latest
docker inspect --format '{{.Image}}' <running container id>   # must match the line above
```

### Failure behaviour (HTTP)

- A missing or mismatched `Authorization: Bearer` credential on any request
  gets `HTTP 401` immediately — before the request body is parsed or the
  MCP layer sees it — and never affects any other in-flight or later
  request on the same process.
- A missing `GATEWAY_API_KEY` at container startup is the same fail-fast
  behaviour as stdio: non-zero exit, error on stderr, process never listens.
  HTTP has no stdout-corruption constraint (stdout isn't a protocol channel
  for this transport), but the fail-fast-on-misconfiguration behaviour
  itself is identical either way.

## Configuration reference

| Variable | Required | Meaning |
|---|---|---|
| `GATEWAY_API_KEY` | yes | The shared secret clients must present. Missing → process exits non-zero at startup, never serves traffic. |
| `GATEWAY_CLIENT_KEY` | stdio only | Must match `GATEWAY_API_KEY`. Checked once at startup. |
| `MCP_TRANSPORT` | no (default `stdio`) | `stdio` or `http`. Any other value falls back to `stdio`. |
| `PORT` | http only | Listen port. No default. |
| `DD_API_KEY`, `DD_APP_KEY` | yes (for real Datadog access) | Forwarded to the `datadog_mcp_cli` child process only — never to the gateway's own clients. |
| `DD_SITE` | no (default `us1`) | One of `us1 eu1 us3 us5 ap1 ap2 staging`. |
| `MCP_ALLOWLIST` | no | Comma-separated tool names. Unset exposes every backend tool. |
| `BACKEND_COMMAND` | no (default `datadog_mcp_cli`) | Override the backend executable — used in this repo's own tests to substitute a mock backend; not needed for normal use since the image already has `datadog_mcp_cli` on `PATH`. |
| `BACKEND_ARGS` | no | Override the backend's argv. |
