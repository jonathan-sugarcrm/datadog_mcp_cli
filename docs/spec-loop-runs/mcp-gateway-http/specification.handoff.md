# Specification handoff: `mcp-gateway-http`

## 1. Slice

**`mcp-gateway-http`** — the same gateway (already proven over stdio in
`mcp-gateway-core`) is reachable over MCP Streamable HTTP, enforcing the
same shared-secret auth and static tool-allowlist semantics, but checked
**per request** rather than once at launch.

## 2. Normalized requirements

### HTTP-AC1 — Valid credential + allowed tool is proxied over HTTP

- **Trigger:** A client sends an HTTP MCP request carrying a valid shared
  secret, calling a tool present in the deployment's allowlist.
- **Preconditions:** `MCP_TRANSPORT=http`; `GATEWAY_API_KEY` set; the
  gateway process is up and has connected to the backend; the target tool
  is in `MCP_ALLOWLIST` (or no allowlist is configured).
- **Expected observable outcome:** The gateway forwards the call to the
  backend and returns the backend's response to the caller over HTTP,
  unmodified — i.e. structurally equal to the backend's own response
  (same standard as AC1's stdio proof, §9.1).
- **Failure behaviour:** N/A — this is the success path; forwarding must
  occur and the backend must be invoked exactly once.
- **Verification method:** Over an HTTP connection, present a valid
  credential and call an allowlisted tool; assert the caller-visible
  response is structurally identical to the backend's own response for
  the same call, and the backend's invocation count is exactly one.
- **Traces to:** AC6 (§9); G1, G3; C4.

### HTTP-AC2 — Missing/invalid credential is rejected on every request, independently

- **Trigger:** A client sends an HTTP MCP request (of any kind, including
  `initialize` or a tool call) without the credential, or with a
  credential that does not match `GATEWAY_API_KEY`.
- **Preconditions:** `MCP_TRANSPORT=http`; `GATEWAY_API_KEY` set; the
  gateway process is up (unlike stdio's AC3, the HTTP process comes up and
  serves requests regardless of any individual caller's credential,
  because HTTP has a per-request channel and multiple callers may share
  one running process — §6).
- **Expected observable outcome:** The request is rejected without the
  backend ever being contacted. Because auth is per-request over HTTP (not
  launch-time), a *separate, later* request on the same running process
  that presents a valid credential must still succeed — rejection of one
  request must not affect any other.
- **Failure behaviour:** The gateway returns an explicit rejection to the
  caller for the unauthenticated/mismatched request (HTTP 401
  Unauthorized, returned before any MCP/JSON-RPC processing of the
  request body) rather than the stdio behaviour of never responding at
  all (§4) — that "no response ever arrives" behaviour is specific to
  stdio's launch-time gate and does not apply once the HTTP process is
  already up and serving other callers.
- **Verification method:** On one running HTTP gateway process, send (a) a
  request with no credential, (b) a request with a mismatched credential,
  and (c) a request with a valid credential and an allowlisted tool call,
  in that order. Assert (a) and (b) each receive an explicit rejection
  (HTTP 401) with the backend invocation count unchanged at zero after
  each, and (c) succeeds and increments the backend invocation count by
  exactly one — proving rejection is per-request, not a process-wide
  launch-time gate.
- **Traces to:** AC6 (§9); §6 (HTTP credential is presented per-request
  and checked on every request); C2.

### HTTP-AC3 — Allowlist semantics carry over unchanged to HTTP

- **Trigger:** (a) A client with a valid credential calls a tool not
  present in the allowlist; (b) a client calls `tools/list` more than once
  in one run, with an unrelated allowed call in between.
- **Preconditions:** `MCP_TRANSPORT=http`; `GATEWAY_API_KEY` set;
  `MCP_ALLOWLIST` configured to a strict subset of backend tools.
- **Expected observable outcome:** (a) The disallowed call is rejected
  before the backend is contacted, with a standard MCP/JSON-RPC error
  object (§4) — not an HTTP-transport-specific error shape, since this is
  the allowlist rejection defined by `mcp-gateway-core`, unchanged by
  transport. (b) `tools/list` returns the same allowlist-filtered tool set
  on every call for the life of the process.
- **Failure behaviour:** For (a), the backend's invocation count must
  remain exactly zero. For (b), any divergence between the two
  `tools/list` results is itself the failure.
- **Verification method:** Mirrors the `mcp-gateway-core` structural
  proofs (§9.1) but driven over HTTP: assert the disallowed call leaves
  backend invocation count at exactly zero (not merely "an error came
  back"), and assert `tools/list` equality across ≥2 calls with an
  unrelated allowed call in between.
- **Traces to:** AC6 (§9); AC2/AC4 semantics (§9, §9.1); C3; C4.

## 3. Verification criteria

| Requirement | Mechanical pass/fail check |
|---|---|
| HTTP-AC1 | Response bytes/structure from an allowed HTTP call == backend's own response for the same call, AND backend invocation count == 1. Any transformation or count != 1 is fail. |
| HTTP-AC2 | For each of a no-credential and a mismatched-credential request: HTTP status is 401 AND backend invocation count does not increase. For the following valid-credential request on the *same process*: call succeeds AND backend invocation count increases by exactly 1. Any served (non-401) response to an invalid/missing credential, or any failure of the subsequent valid call, is fail. |
| HTTP-AC3 | Disallowed call: backend invocation count == 0 AND response is a standard MCP/JSON-RPC error object (has an error code + message field, not a bespoke shape). `tools/list` called twice (with an unrelated allowed call between): both results are set-equal. Any nonzero invocation count, non-JSON-RPC-error shape, or `tools/list` divergence is fail. |

## 4. Explicit scope

**In:**
- Per-request shared-secret auth over HTTP, checked on every request
  independently (no launch-time-only gate as in stdio).
- Allowlist enforcement and `tools/list` filtering carried over to the
  HTTP transport unchanged from `mcp-gateway-core` semantics.
- Proxying allowed HTTP calls to the same backend child process used by
  the stdio transport, with response fidelity (AC1-equivalent proof).
- The specific rejection shape for an unauthenticated/mismatched HTTP
  request (HTTP 401, returned pre-MCP-layer) as the HTTP-transport
  analogue of AC3.

**Out (explicitly, per spec):**
- Any change to logging behaviour or the `outcome` enum — §6/AC5 already
  cover this and are transport-agnostic; this slice does not re-derive
  logging requirements. (Stdout is not a reserved channel for HTTP per
  C6, so no stdout-avoidance behaviour is required or tested here.)
- TLS/HTTPS termination, reverse proxying, or any hosting-platform
  concern — hosting platform is explicitly not prescribed (§3.2, §5).
- Health-check or readiness endpoints — not mentioned anywhere in the
  spec; inventing one would be scope creep beyond AC6.
- Runtime-editable allowlist — remains static/deploy-time only (C3),
  unchanged by transport.
- Per-user identity/attribution over HTTP — remains out per C2/§3.2
  even though HTTP has a per-request channel; the shared secret is still
  a single, non-attributable value per §6.
- Packaging/documentation of the standalone hosted deployment itself —
  that is `mcp-gateway-packaging` (AC7/AC8), which depends on this slice
  but is not part of it.
- The concrete HTTP route/path the gateway listens on for MCP traffic,
  and the exact header name carrying the credential, beyond what is
  fixed below as a Class 3 choice — these are implementation details the
  next stage documents, not fixed contract requirements from this spec.

## 5. Unresolved decisions

None — cleared at gate 2. Every unknown needed to fill the five fields
above was resolved as Class 2 (cited below) or Class 3 (rationale below);
none rose to a genuine one-way-door product/scope decision. (Note: this
pipeline pass runs unattended; per the autonomy override, transport-
mechanics unknowns that might normally prompt a question were re-examined
against the classification procedure and resolved rather than left open.)

## 6. Recorded facts & safe choices

**Class 2 — investigated, single answer, cited from `docs/SPECIFICATION.md`:**

1. *The HTTP credential is the same shared secret checked against
   `GATEWAY_API_KEY`, presented per-request and checked on every request*
   (not a separate stdio-style `GATEWAY_CLIENT_KEY` launch-time value).
   — Cited: §6, "Over HTTP (`mcp-gateway-http`, later slice), the
   credential is presented per-request in a header and checked on every
   request, since HTTP has an obvious per-call channel and multiple
   callers may share one running process."
2. *The disallowed-tool rejection (allowlist case) must be a standard
   MCP/JSON-RPC error object, not a bespoke shape, and this is unchanged
   by transport.* — Cited: §4, "A disallowed tool on `tools/call` (AC2)
   is rejected with a standard MCP/JSON-RPC error object... established
   by `mcp-gateway-core`."
3. *Stdio's "no response ever arrives" rejection behaviour for AC3 is
   specific to the stdio launch-time gate and explicitly does not
   describe HTTP's per-request case.* — Cited: §4, "This does **not**
   apply to AC3's stdio invalid/missing key case... per §6, an invalid
   `GATEWAY_CLIENT_KEY` means the process never comes up... there is no
   server-transport error object to return."
4. *There is no stdout-avoidance constraint for the HTTP transport* (C6
   only binds stdio). — Cited: §8 C6, "Does not apply to the HTTP
   transport (`mcp-gateway-http`), which has no equivalent stdout
   constraint," and §7's `MCP_TRANSPORT`/`PORT` variables confirm HTTP is
   a distinct, already-named configuration mode.
5. *Config schema (env vars) is shared between transports by design* —
   used to fix preconditions (`MCP_TRANSPORT=http`, `GATEWAY_API_KEY`,
   `MCP_ALLOWLIST`, `PORT`). — Cited: §7 table and C4, "Local and
   standalone-cloud deployments must share the same image and
   environment-variable configuration schema."

**Class 3 — safe, reversible, no contract impact (decided, with rationale):**

1. **Unauthenticated/mismatched HTTP request is rejected with HTTP status
   401, returned before any MCP/JSON-RPC processing of the request body.**
   Rationale: the spec establishes *that* HTTP has "an obvious per-call
   channel" for the credential (§6) but does not fix the wire-level
   rejection shape. A native HTTP status code is the idiomatic per-request
   auth signal on this transport (unlike stdio, which has no such channel
   and therefore uses "no response at all" per §4) and is trivially
   changeable later without breaking any stated constraint or downstream
   AC, since no other slice or AC depends on a specific status code.
2. **The credential header name and the exact HTTP route/path used for
   MCP traffic are left as implementation details for the next stage to
   document, rather than fixed here.** Rationale: nothing in §4/§6/§7
   names a header or path, no constraint (C1–C6) depends on either being
   a specific value, and both are purely internal to this gateway (caller
   and server are built/documented together) — so fixing one now would be
   inventing a requirement the spec doesn't state, while leaving it
   undecided doesn't block writing evaluable, pass/fail acceptance
   criteria (the verification checks above test behaviour, not the exact
   header/path spelling).
3. **No health-check/readiness endpoint is assumed to exist for this
   slice.** Rationale: AC6 and §4 describe only MCP request/response
   semantics; a health endpoint is unmentioned anywhere in the spec, so
   adding one would be scope creep, not a gap that needs filling to
   satisfy AC6.
4. **No default value is assumed for `PORT`.** Rationale: §7 documents
   `PORT` as "HTTP listen port (HTTP transport only)" with no stated
   default (contrast with `MCP_TRANSPORT`, whose default of `stdio` *is*
   stated in §7). Verification simply sets `PORT` explicitly for the
   test run rather than relying on an invented default, so no assumption
   is needed either way.
