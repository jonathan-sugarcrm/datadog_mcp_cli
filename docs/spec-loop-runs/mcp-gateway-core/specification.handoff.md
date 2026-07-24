# Specification handoff: `mcp-gateway-core`

## 1. Slice

**Slice id:** `mcp-gateway-core`
**Outcome:** The gateway enforces shared-secret auth (stdio,
launch-time-only) and a static tool allowlist while proxying allowed
`tools/call` requests to the `datadog_mcp_cli` backend, over stdio.
Covers `docs/SPECIFICATION.md` §9 AC1–AC5.

## 2. Normalized requirements

### CORE-01 — Launch-time shared-secret gate (stdio)

- **Trigger:** The gateway process is launched over stdio.
- **Preconditions:** `GATEWAY_API_KEY` is configured for the deployment
  (§7); `GATEWAY_CLIENT_KEY` is whatever the launcher supplied (present,
  absent, or mismatched).
- **Expected observable outcome:** When `GATEWAY_CLIENT_KEY` matches
  `GATEWAY_API_KEY`, the process proceeds to connect to the
  `datadog_mcp_cli` backend and starts serving the MCP server transport —
  checked once, before anything else runs (§6).
- **Failure behaviour:** When `GATEWAY_CLIENT_KEY` is absent or does not
  match `GATEWAY_API_KEY`, the process does not connect to the backend and
  does not start the server transport — no `tools/list` or `tools/call`
  request is ever answered for this process instance (§6, AC3).
- **Verification method:** Smoke test, two runs. (a) Launch with a
  matching key; assert the backend child process is spawned and a
  `tools/list` request gets a response. (b) Launch with a missing or
  mismatched key; assert within a bounded timeout that the backend child
  process is never spawned and no MCP request receives a response.
- **Traces to:** G1; C2; §6; AC3.

### CORE-02 — Allowlist gates `tools/list` and `tools/call`, allowed calls are proxied verbatim

- **Trigger:** A caller (past CORE-01) sends `tools/list`, or sends
  `tools/call` for a named tool.
- **Preconditions:** Gateway completed startup per CORE-01's happy path;
  `MCP_ALLOWLIST` is set to a subset of backend tool names, or left unset.
- **Expected observable outcome:** `tools/list` returns exactly the
  intersection of the backend's tools and `MCP_ALLOWLIST` (or every
  backend tool when unset), unchanged for the process's entire lifetime
  (§4, AC4). `tools/call` for a tool inside that set is forwarded to the
  backend and the backend's response is returned to the caller unmodified
  (§4, AC1).
- **Failure behaviour:** `tools/call` for a tool outside the configured
  set is rejected with an error before the backend is contacted at all —
  the backend receives zero invocations for that request (§4, AC2). If a
  forwarded (allowed) call's backend invocation itself errors, the gateway
  relays that error to the caller rather than fabricating success.
- **Verification method:** Start the gateway with `MCP_ALLOWLIST` set to a
  strict, known subset of backend tools. (a) Call `tools/list` at least
  twice across the run (e.g. before/after an unrelated call) and assert
  both responses equal exactly that subset. (b) Call an allowed tool and
  assert the caller-visible response equals the backend's own response to
  the same call. (c) Call a tool outside the subset and assert the caller
  gets an error and the backend records zero invocations for it. (d) Repeat
  with `MCP_ALLOWLIST` unset and assert the full backend tool set is
  returned.
- **Traces to:** G1; G2; C3; AC1; AC2; AC4.

### CORE-03 — Per-call logging without caller identity or secrets

- **Trigger:** A `tools/call` request reaches a definitive outcome under
  CORE-02 — forwarded-and-completed (success or backend error), or
  allowlist-rejected.
- **Preconditions:** Gateway is past CORE-01 (serving requests).
- **Expected observable outcome:** Exactly one log entry is emitted per
  such request, containing the tool name, a timestamp, and the outcome
  (success/failure/rejected).
- **Failure behaviour:** The entry never contains a caller-identifying
  field, and never contains the literal value of `GATEWAY_API_KEY`,
  `GATEWAY_CLIENT_KEY`, `DD_API_KEY`, or `DD_APP_KEY` — this holds
  identically whether the logged outcome is success, backend failure, or
  allowlist rejection (§6, C1, C5, AC5).
- **Verification method:** Trigger one forwarded call that succeeds, one
  forwarded call the backend errors on, and one allowlist-rejected call.
  Capture the log output for each. Assert each has exactly one entry with
  non-empty tool name + timestamp + outcome fields, and grep each entry for
  the configured secret values and for any caller-identity field, asserting
  zero matches.
- **Traces to:** C1; C5; AC5.

## 3. Verification criteria

| Requirement | Mechanical check |
|---|---|
| CORE-01 | Matching key → backend spawn count = 1 and `tools/list` gets a response. Missing/mismatched key → backend spawn count = 0 and zero MCP requests get any response, within a bounded timeout. Any other outcome is FAIL. |
| CORE-02 | `tools/list` result set == (backend tools ∩ configured allowlist), or == full backend set when unset, stable across ≥2 calls in one run. Allowed `tools/call` → caller response == backend's own response for the same call. Disallowed `tools/call` → backend invocation count = 0 and caller gets an error. Any mismatch, drift, or a backend invocation on a disallowed call is FAIL. |
| CORE-03 | For each of {success, backend-failure, allowlist-rejection} outcomes: exactly one log entry exists with non-empty tool name + timestamp + outcome, and a grep of that entry for the literal `GATEWAY_API_KEY`/`GATEWAY_CLIENT_KEY`/`DD_API_KEY`/`DD_APP_KEY` values and for any caller-identity field returns no match. Missing/duplicate entry, missing field, or a match on a forbidden value is FAIL. |

## 4. Explicit scope

**In scope for this slice:**

- Startup-time validation of `GATEWAY_CLIENT_KEY` against `GATEWAY_API_KEY`
  over stdio, gating both backend connection and server-transport start
  (§6, §7).
- Connecting to the `datadog_mcp_cli` backend as an MCP client over stdio
  using `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE`.
- Computing `tools/list` as the intersection of backend tools and
  `MCP_ALLOWLIST` (or full backend set when unset), fixed for process
  lifetime.
- Enforcing the allowlist on `tools/call`, rejecting before contacting the
  backend for disallowed tools.
- Forwarding allowed `tools/call` requests to the backend and relaying its
  response verbatim, including relaying backend errors.
- Per-call logging of tool name, timestamp, outcome, excluding caller
  identity and both secrets (`GATEWAY_*_KEY`, `DD_*_KEY`).

**Out of scope for this slice:**

- HTTP transport, per-request header-based auth (`mcp-gateway-http`, AC6).
- Docker packaging and standalone-hosting documentation
  (`mcp-gateway-packaging`, AC7–AC8).
- Per-user authentication/SSO, per-user attribution/audit trails,
  runtime-editable allowlist, wiring into a broader compose topology,
  choice of cloud host (spec §3.2 non-goals).
- Backend-process crash/restart policy beyond relaying a single call's
  error outcome (not specified by AC1–AC5 for this slice).
- Exact wording/format of the "clear error" beyond it being a
  caller-visible MCP/JSON-RPC error response (see §6 recorded facts).
- C4 (identical image/config schema across local and standalone-cloud) —
  not exercised until `mcp-gateway-http`/`mcp-gateway-packaging`.

## 5. Unresolved decisions

None — cleared at gate 2. The previous open question from this slice's
prior pass (how a caller presents the shared secret over stdio) is now
resolved by the stakeholder directly in `docs/SPECIFICATION.md` §6 and §7:
presentation is launch-time-only via the `GATEWAY_CLIENT_KEY` env var,
checked once at startup against `GATEWAY_API_KEY`, before the backend
connection or server transport start. This is recorded below as a Class 2
fact and reflected in CORE-01.

## 6. Recorded facts & safe choices

**Class 2 — facts (with citation):**

- Stdio auth presentation is launch-time-only: the process refuses to
  connect to the backend or start the server transport unless
  `GATEWAY_CLIENT_KEY` is present and equals `GATEWAY_API_KEY` at startup,
  checked once before anything else runs. *(Citation:
  `docs/SPECIFICATION.md` §6 "Product decision (resolved)" paragraph and
  §7 config table row for `GATEWAY_CLIENT_KEY`.)*
- "Invalid/missing key" (AC3) means the process never comes up to serve
  requests at all — there is no partial-startup state where the server
  transport is live but rejecting individual calls. *(Citation: §6, same
  paragraph: "the process never comes up to serve requests.")*
- `tools/list` scope is the intersection of backend tools and
  `MCP_ALLOWLIST`; an unset allowlist exposes every backend tool.
  *(Citation: §4 "Architecture & wiring," Tool exposure bullet.)*
- Rejection of a disallowed tool happens before the backend is contacted.
  *(Citation: §4, same bullet: "`tools/call` for a tool outside the
  allowlist is rejected before the backend is ever contacted.")*
- Logs must never contain caller identity, the shared secret, or the
  Datadog credential. *(Citation: §6 "Logs record tool name, timestamp,
  and outcome only..."; C1; C5.)*

**Class 3 — safe choices (with rationale):**

- Treat an allowlist-rejected call as a loggable "completion" under AC5's
  "success or failure" wording, distinct from the CORE-01 startup-key
  failure case (which produces no served call at all, hence nothing to log
  at the call level). Chose to log allowlist rejections over silently
  excluding them because AC5's outcome field exists precisely to
  distinguish success/failure/rejected outcomes, and this is reversible (a
  logging-scope change, not a contract change).
- The caller-visible error for a disallowed tool or a backend failure is a
  standard MCP/JSON-RPC error object (code + message) rather than a
  custom error shape. Chose this over a bespoke format because it follows
  the existing MCP protocol convention already implied by the gateway's
  role as an MCP server, is reversible, and has no contract impact beyond
  satisfying the "clear error" wording in AC2/AC3.
- A single structured log line per call (fields: tool name, ISO-8601
  timestamp, outcome enum `success`/`failure`/`rejected`) is used rather
  than any richer shape, because AC5/C5 require only those three fields and
  no identity field — the concrete serialization is a two-way door with no
  contract impact.
