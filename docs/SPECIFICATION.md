# Specification: Datadog MCP Gateway

Source: GitHub issue jonathan-sugarcrm/datadog_mcp_cli#1
(https://github.com/jonathan-sugarcrm/datadog_mcp_cli/issues/1)

## 1. Overview

A gateway MCP server that sits in front of the existing Datadog MCP CLI
(`datadog_mcp_cli`, see repo root `Dockerfile`/`dd-mcp-proxy.sh`). It holds the
org's single Datadog credential centrally, authenticates callers with one
shared secret instead of per-user Datadog tokens, and exposes only an
admin-configured allowlist of the underlying Datadog MCP tools. It must run
identically as a local Docker process (stdio transport) and as a standalone
cloud-hosted service (HTTP transport), from the same image/config schema.

## 2. Goals

- **G1** — Org members can use Datadog MCP tools without holding or managing
  their own Datadog API token.
- **G2** — An admin can restrict, per deployment, which Datadog tools are
  reachable through the gateway.
- **G3** — The same build is deployable both as a local Docker process and as
  a standalone cloud-hosted service, with no code/config-format branching
  between the two.

## 3. Scope & slicing

### 3.1 In scope

- Shared-secret authentication of callers to the gateway (one secret per
  deployment).
- Static, deploy-time tool allowlist that filters which backend Datadog MCP
  tools are exposed via `tools/list` and enforced on `tools/call`.
- Proxying allowed calls to the real `datadog_mcp_cli` backend using a
  centrally held Datadog credential (`DD_API_KEY`/`DD_APP_KEY`).
- Two transports from one codebase/config schema: MCP stdio (local Docker)
  and MCP Streamable HTTP (standalone cloud host).
- Per-call logging (tool name, timestamp, outcome) without caller identity.
- Local Docker packaging (image + documented compose/run) and docs for
  running the same image as a standalone hosted container.

### 3.2 Out of scope (see issue non-goals)

- Per-user authentication/SSO to the gateway.
- Per-user call attribution or audit trails.
- Runtime-editable allowlist without restart/redeploy.
- Wiring the proxy into an existing broader local sandbox network/compose
  topology.
- Selecting/provisioning the specific cloud hosting platform.

### 3.3 The thin delta (slice backlog)

| Slice id | Outcome | Depends on |
|---|---|---|
| `mcp-gateway-core` | Gateway enforces shared-secret auth and a static tool allowlist while proxying allowed calls to the Datadog backend, over stdio. | none |
| `mcp-gateway-http` | The same gateway is reachable over HTTP with the same auth/allowlist semantics. | `mcp-gateway-core` |
| `mcp-gateway-packaging` | Documented local Docker run + standalone hosted container instructions for the same image. | `mcp-gateway-http` |

`mcp-gateway-core` is done (AC1–AC5 verified PASS). This pass targets
**`mcp-gateway-http`**.

## 4. Architecture & wiring

- The gateway is an MCP server process. On startup it connects, as an MCP
  *client*, to the real `datadog_mcp_cli` binary as a child process over
  stdio — this is the only component holding `DD_API_KEY`/`DD_APP_KEY`.
- The gateway exposes itself as an MCP *server* to callers: over stdio when
  run locally, over Streamable HTTP when run standalone.
- Tool exposure: `tools/list` returns the intersection of the backend's tools
  and the configured allowlist (or every backend tool when no allowlist is
  configured). `tools/call` for a tool outside the allowlist is rejected
  before the backend is ever contacted.
- The backend child process's environment is a narrow, explicit allowlist —
  `DD_API_KEY`, `DD_APP_KEY`, and `DD_SITE` (plus the MCP SDK's own safe
  defaults) are forwarded to it. The gateway's own shared secrets
  (`GATEWAY_API_KEY`/`GATEWAY_CLIENT_KEY`) are never forwarded to the backend
  process (established by `mcp-gateway-core`; follows the existing
  `dd-mcp-proxy.sh` convention of naming only the Datadog keys explicitly
  rather than passing through the full environment).
- A disallowed tool on `tools/call` (AC2) is rejected with a standard
  MCP/JSON-RPC error object (error code + message), not a bespoke error
  shape — this is what "a clear error" means in §9 AC2 (established by
  `mcp-gateway-core`). This does **not** apply to AC3's stdio invalid/missing
  key case: per §6, an invalid `GATEWAY_CLIENT_KEY` means the process never
  comes up to serve requests at all, so there is no server-transport error
  object to return — the "rejection" is the process refusing to start,
  observed as no MCP response ever arriving (§9.1 AC3).

## 5. Deployment model

- Local: single Docker image, stdio transport, launched by an MCP client's
  `command`/`args`/`env` config (see repo root `mcp-datadog.example.json`
  pattern).
- Cloud/standalone: the same image, HTTP transport, listening on a
  configurable port. Specific hosting platform is not prescribed (§3.2).
- Configuration is environment-variable based in both modes so the only
  difference between them is how secrets are injected (local `.env` /
  docker-compose vs. whatever the eventual host's secret mechanism is).

## 6. Security model

- Callers present a shared secret. There is no per-user identity — this is a
  deliberate, accepted tradeoff (issue "Risks").
- **Product decision (resolved):** over stdio, the launcher and the caller
  are the same actor for a session, so there is no separate per-call
  credential channel. The presentation mechanism for stdio is
  **launch-time-only**: the process refuses to serve any MCP traffic (does
  not connect to the backend, does not start the server transport) unless
  the env var `GATEWAY_CLIENT_KEY` is present and matches `GATEWAY_API_KEY`
  at startup, checked once before anything else runs. "Invalid/missing key"
  (§9 AC3) therefore means the process never comes up to serve requests.
  This is a one-way-door choice for stdio integrators, made now rather than
  left open, because a per-call parameter has no natural place in a
  single-session stdio pipe. Over HTTP (`mcp-gateway-http`, later slice),
  the credential is presented per-request in a header and checked on every
  request, since HTTP has an obvious per-call channel and multiple callers
  may share one running process.
- The Datadog credential never leaves the gateway process; callers only ever
  see the gateway's own tool responses.
- Logs record tool name, timestamp, and outcome only — never a caller
  identity field, and never the shared secret or the Datadog credential.
- The `outcome` field takes exactly one of three values: `success`,
  `failure`, or `rejected` (established by `mcp-gateway-core`; tightens §9
  AC5's "outcome" into an evaluable enum). `rejected` covers an
  allowlist-blocked `tools/call`; the CORE-01-style launch-time key failure
  produces no served call at all, so it has nothing to log at the call
  level.
- For the stdio transport, log output must never be written to stdout —
  stdout is the MCP JSON-RPC channel itself, and any interleaved log line
  would corrupt every response. Per-call logs are written to stderr (or
  another out-of-band channel) instead (see §8 C6).
- If `GATEWAY_API_KEY` itself is unset (a configuration error, distinct from
  a caller presenting an invalid `GATEWAY_CLIENT_KEY`), the process fails
  fast to stderr and exits non-zero without writing to stdout — this is
  config-loading behaviour, not the AC3 auth-check path (established by
  `mcp-gateway-core`).

## 7. Configuration (environment variables)

| Variable | Meaning |
|---|---|
| `GATEWAY_API_KEY` | The shared secret the gateway expects. Required. |
| `GATEWAY_CLIENT_KEY` | Stdio transport only: the secret the launcher presents; checked once at startup against `GATEWAY_API_KEY` (§6). |
| `MCP_TRANSPORT` | `stdio` (default) or `http`. |
| `MCP_ALLOWLIST` | Comma-separated tool names to expose. Unset = expose every backend tool. |
| `PORT` | HTTP listen port (HTTP transport only). |
| `DD_API_KEY`, `DD_APP_KEY` | Centrally held Datadog credential, forwarded to the backend process. |
| `DD_SITE` | Datadog site region passed to the backend. |

## 8. Constraints

- **C1** — The Datadog credential (`DD_API_KEY`/`DD_APP_KEY`) must never be
  exposed to callers or logged.
- **C2** — Auth is a single shared secret per deployment; no per-caller
  identity is available or required (accepted risk, issue "Risks").
- **C3** — The allowlist is static/deploy-time only; changing it requires a
  restart/redeploy (accepted, issue "Non-goals").
- **C4** — Local and standalone-cloud deployments must share the same
  image and environment-variable configuration schema; only secret
  injection may differ.
- **C5** — Logging must never include caller-identifying information.
- **C6** — Over the stdio transport, log output must never be written to
  stdout — stdout is the reserved MCP JSON-RPC channel; logs go to stderr
  (or another out-of-band sink). Discovered while implementing
  `mcp-gateway-core`: the pre-existing scratch code logged to stdout and
  would have corrupted every MCP response under real use. Does not apply
  to the HTTP transport (`mcp-gateway-http`), which has no equivalent
  stdout constraint.

## 9. Acceptance criteria

Restated from the issue; slice `mcp-gateway-core` covers AC1–AC5. AC6–AC8
belong to later slices (`mcp-gateway-http`, `mcp-gateway-packaging`).

1. **AC1** — Given a client sends a valid shared API key, when it calls a
   tool present in the deployment's allowlist, then the gateway forwards the
   call to the backend and returns the response.
2. **AC2** — Given a client calls a tool not present in the allowlist, when
   the request is received, then the gateway rejects it without forwarding
   to the backend, with a clear error.
3. **AC3** — Given a client omits or sends an invalid shared API key, when it
   calls any tool, then the gateway rejects the request without forwarding
   to the backend.
4. **AC4** — Given the gateway is deployed, when an admin sets the allowlist
   via static configuration before startup, then only those tools are
   exposed for that deployment's lifetime.
5. **AC5** — Given the gateway handles a call, when it completes (success or
   failure), then it logs tool name, timestamp, and outcome without caller
   identity.
6. **AC6** — The same image is reachable over Streamable HTTP with the same
   auth/allowlist semantics as stdio. (`mcp-gateway-http`)
7. **AC7** — The gateway is packaged as a single Docker image runnable
   locally via a documented compose/run command. (`mcp-gateway-packaging`)
8. **AC8** — The same image is documented as deployable as a standalone
   hosted service using the same env-var configuration schema.
   (`mcp-gateway-packaging`)

### 9.1 Verification methods established by `mcp-gateway-core`

These sharpen AC1–AC5 from prose into the bounded checks actually proven for
this slice, and are the baseline future slices' verification should match
or exceed:

- **AC1/AC2** — verified structurally: an allowed call's caller-visible
  response must equal the backend's own response with no transformation,
  and a disallowed call must leave the backend's invocation count at
  exactly zero — not merely "an error was returned."
- **AC3** — verified via a bounded-timeout race: with a missing/mismatched
  key, no MCP request (not even `initialize`) ever receives a response,
  proven within a fixed timeout rather than by checking one request's
  status.
- **AC4** — verified by asserting `tools/list` equality across ≥2 calls in
  one run (with an unrelated call in between), not a single snapshot —
  proving stability for the process's lifetime, not just at startup.
- **AC5** — verified by capturing raw log output (not a summary) and
  grepping it literally for every secret value and a caller-identity
  marker, asserting zero matches, across all three `outcome` values
  (`success`/`failure`/`rejected`, §6).

## 10. Open questions

None — cleared during story refinement (see issue #1 discussion). No new
product decisions were surfaced by `mcp-gateway-core`'s implementation or
verification; every discovery was a Class 2/3 fact or safe choice, folded
into §4/§6/§8/§9 above rather than left as an open question.
