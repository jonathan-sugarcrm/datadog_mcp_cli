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

`mcp-gateway-core`, `mcp-gateway-http`, and `mcp-gateway-packaging` are all
done (AC1–AC5, AC6, and AC7–AC8 verified PASS). The slice backlog is now
**fully complete — no slice remains**.

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
- **HTTP wiring (established by `mcp-gateway-http`):** the credential is
  presented as `Authorization: Bearer <key>` on the single route `POST /mcp`;
  a request whose credential is missing or mismatched gets `HTTP 401` before
  the request body is parsed or handed to the MCP layer (no backend
  contact). Each HTTP request gets a fresh MCP `Server` + stateless
  `StreamableHTTPServerTransport` pair — cheap, since tool
  listing/allowlist logic is stateless — so that rejecting one request never
  affects a later valid request on the same process; the one genuinely
  expensive, stateful resource (`backendClient`, the connection to the
  Datadog backend) is still created once per process and shared across
  requests. None of these choices (header name, route, status code) is
  depended on by any contract or other slice — they are two-way doors.
- **Packaging (established by `mcp-gateway-packaging`):** `gateway/Dockerfile`
  builds a single image with a `downloader` stage that `curl`-fetches the
  real `datadog_mcp_cli` binary and verifies it against a pinned
  `SHA256_AMD64` build arg via `sha256sum --check --strict` before it is
  copied into the final stage — the binary is embedded directly in the
  image, not fetched or built at container-run time. There is no
  docker-in-docker: the gateway's child-process spawn of `datadog_mcp_cli`
  (§4 above) is a plain OS-level `execve` of the embedded binary inside the
  same container, not a nested container launch. A pinned-hash mismatch
  aborts the build itself (`docker build` exits non-zero) rather than
  surfacing at runtime.

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
  single-session stdio pipe. Over HTTP (established by `mcp-gateway-http`),
  the credential is presented per-request as an `Authorization: Bearer <key>`
  header, checked against `GATEWAY_API_KEY` before the request body is
  parsed or handed to the MCP layer; a missing/mismatched credential gets
  `HTTP 401` and the backend is never contacted for that request. Multiple
  callers may share one running process, and rejecting one request does not
  affect a later valid request on the same process (§9.1 AC6).
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

Restated from the issue; slice `mcp-gateway-core` covers AC1–AC5 (verified
PASS), slice `mcp-gateway-http` covers AC6 (verified PASS), and slice
`mcp-gateway-packaging` covers AC7–AC8 (verified PASS). All three slices in
the §3.3 backlog are now complete.

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

### 9.1 Verification methods established by `mcp-gateway-core` and `mcp-gateway-http`

These sharpen AC1–AC6 from prose into the bounded checks actually proven for
each slice, and are the baseline later slices' verification should match or
exceed:

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
- **AC6** — verified via three sharpened checks over HTTP
  (`mcp-gateway-http`): (a) HTTP-AC1: a valid-credential, allowlisted call's
  caller-visible response must equal the backend's own response with no
  transformation (same structural-equality bar as AC1), and the backend is
  invoked exactly once; (b) HTTP-AC2: a missing/mismatched credential is
  rejected with `HTTP 401` before the backend is contacted, checked
  per-request rather than once at launch (unlike stdio's AC3) — proven by
  rejecting on one request and then succeeding with a valid credential on a
  *later* request on the same running process; (c) HTTP-AC3: a disallowed
  tool is rejected with a standard JSON-RPC error object (top-level
  `error.code`/`error.message`, not a bespoke HTTP shape) with the backend
  invocation count staying at zero, and `tools/list` returns the same
  allowlist-filtered set across ≥2 calls in one run (same stability bar as
  AC4). **Known non-blocking gap:** HTTP-AC1's "no allowlist configured"
  precondition branch was exercised only transitively over HTTP (via the
  shared `filterTools`/`buildGatewayServer` code path, already covered by
  unit tests and by `mcp-gateway-core`'s stdio AC1 test), not by a dedicated
  HTTP integration test. Logged here rather than silently dropped; does not
  change AC6's verified-PASS status, since the stated method for HTTP-AC1
  requires only a valid credential + allowlisted-tool call over HTTP, which
  was reproduced directly.
- **AC7/AC8** — verified via two sharpened checks (`mcp-gateway-packaging`,
  criteria PKG-01/PKG-02): (a) PKG-01 — a genuine `docker build --no-cache`
  from scratch exits 0 and produces a working image, proven by driving a
  real MCP client over stdio with the README's documented run command
  (verbatim hardening flags: `--read-only`/`--tmpfs`/`--cap-drop=ALL`/etc.)
  to a non-error `initialize`/`tools/call` response; the failure paths are
  both covered — a missing `GATEWAY_API_KEY` at runtime yields a bounded,
  timed race showing no MCP response is ever produced (matching AC3's
  method above), and a tampered pinned-`SHA256_AMD64` build arg aborts
  `docker build` itself (non-zero exit) via `sha256sum --check --strict`,
  not merely a docs-level assertion that the check exists; (b) PKG-02 — the
  *same image digest* (confirmed byte-for-byte via `docker inspect`, not
  assumed) is run standalone with `MCP_TRANSPORT=http`, and a real
  `POST /mcp` exchange returns a response structurally equal to the
  backend's own, over the identical image used for PKG-01 — proving "same
  image, only secret injection/transport env differ" (C4) rather than
  assuming it; failure paths cover a missing/mismatched `Authorization:
  Bearer` credential (`HTTP 401` before backend contact, with isolation
  confirmed across requests on the same process) and a missing
  `GATEWAY_API_KEY` at HTTP startup (same fail-fast-to-stderr/non-zero-exit
  shape as PKG-01's stdio path). **Known non-blocking gap:** the
  README's HTTP run example omits the hardening flags
  (`--read-only`/`--tmpfs`/`--cap-drop=ALL`/`--security-opt=no-new-
  privileges`/`--pids-limit`/`--memory`) present in the stdio example.
  Confirmed by verification to make no behavioural difference — the same
  hardened flags were re-run against the HTTP transport and returned an
  identical, valid `initialize` response — so this is a documentation
  completeness gap, not a C4 violation or an AC7/AC8 defect. Left as a
  known minor gap rather than routed as a fix, since resolving it means
  editing `gateway/README.md`, not this spec.

## 10. Open questions

None — cleared during story refinement (see issue #1 discussion). No new
product decisions were surfaced by `mcp-gateway-core`'s, `mcp-gateway-http`'s,
or `mcp-gateway-packaging`'s implementation or verification; every discovery
— including `mcp-gateway-http`'s Class 3 choices (credential header name,
HTTP route, rejection status code, per-request isolation strategy), its
one non-blocking evidence gap (HTTP-AC1's untested "no allowlist" branch,
§9.1 AC6), `mcp-gateway-packaging`'s architecture fact (the embedded,
pinned-SHA256 `datadog_mcp_cli` binary with no docker-in-docker, §4), and
its one non-blocking documentation-completeness gap (the README's HTTP run
example omitting the hardening flags shown in its stdio example, §9.1
AC7/AC8) — was a Class 2/3 fact, a two-way-door implementation choice, or a
documented known gap, folded into §4/§6/§9.1 above rather than left as an
open question.

The slice backlog (§3.3) is now fully complete: `mcp-gateway-core`,
`mcp-gateway-http`, and `mcp-gateway-packaging` have all been implemented
and independently verified PASS (AC1–AC8, no classified failures). No
slice remains in the backlog.
