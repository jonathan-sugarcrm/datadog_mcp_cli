# Implementation handoff: `mcp-gateway-http`

Input: `docs/spec-loop-runs/mcp-gateway-http/specification.handoff.md` (consumed only;
no other source of requirements used).

## 1. Implementation plan

1. `gateway/src/config.js` — add `transport` (from `MCP_TRANSPORT`, default `stdio`) and
   `port` (from `PORT`, no invented default) to the loaded config -> verify:
   `loadConfig` unit tests for both fields (`gateway/test/unit.test.js`).
2. `gateway/src/server-http.js` (new) — HTTP transport entrypoint: connect to the backend
   once per process; per HTTP request, extract the `Authorization: Bearer` credential,
   reject with 401 before any MCP/JSON-RPC processing if it doesn't match
   `GATEWAY_API_KEY`, otherwise build a gateway `Server` + stateless
   `StreamableHTTPServerTransport` for that request and hand it off -> verify:
   HTTP-AC1/AC2/AC3 integration tests (`gateway/test/http.test.js`).
3. `gateway/src/index.js` — dispatch to `runHttp` vs `runStdio` based on
   `config.transport` -> verify: same HTTP integration tests (they drive the real
   subprocess through `index.js`); existing stdio tests unaffected.
4. `gateway/test/fixtures/mock-datadog-server.js` — extend the mock backend with an
   optional calls-log file (arg 2) so an out-of-process HTTP test can observe backend
   invocation count without a direct connection to the backend -> verify: used by every
   HTTP-AC1/2/3 test to assert invocation counts.
5. `gateway/test/http.test.js` (new) — drive the real gateway subprocess over a real TCP
   socket for HTTP-AC1, HTTP-AC2 (x3: no-cred, bad-cred, same-process valid-after-reject),
   HTTP-AC3 (x2: disallowed call, tools/list stability) -> verify: `npm test` green.

Dependency order: (1) before (2)/(3) (both need `config.transport`/`port`); (4) before (5)
(tests need the calls-log instrumentation); (2) and (3) are co-dependent (index.js can't
dispatch to a transport that doesn't exist yet) and were done together.

## 2. Changed files

| File | Reason |
|---|---|
| `gateway/src/config.js` | Adds `transport`/`port` fields needed by HTTP-AC1/2/3 preconditions (`MCP_TRANSPORT=http`, `PORT`). |
| `gateway/src/index.js` | Dispatches to the HTTP transport when `config.transport === 'http'`, required for all three HTTP-AC*. |
| `gateway/src/server-http.js` | New — implements the per-request auth gate (HTTP-AC2) and HTTP proxying (HTTP-AC1); reuses `buildGatewayServer`/`connectBackend` from `gateway.js` unchanged, so allowlist/`tools/list` semantics (HTTP-AC3) carry over for free. |
| `gateway/test/fixtures/mock-datadog-server.js` | Adds an optional calls-log file so HTTP tests (which never talk to the backend directly) can observe backend invocation count — required by every HTTP-AC verification method. |
| `gateway/test/http.test.js` | New — evidence-producing tests for HTTP-AC1, HTTP-AC2, HTTP-AC3. |
| `gateway/test/unit.test.js` | Adds unit coverage for the new `transport`/`port` config fields (traces to the same preconditions as above). |

No other file was touched. `gateway/src/auth.js`, `gateway/src/gateway.js`,
`gateway/src/logger.js`, `gateway/src/server-stdio.js` are unchanged — HTTP-AC3's "carry
over unchanged" requirement is satisfied by reuse, not reimplementation.

## 3. Decision log

Class 3 choices concretized by the code (spec left these as implementation details, §4 of
the spec handoff):

1. **Credential header: `Authorization: Bearer <key>`.** Chose this over a bespoke header
   (e.g. `X-Gateway-Key`) because it is the idiomatic HTTP credential channel and is what
   the MCP SDK's own `StreamableHTTPClientTransport` sends by default given a bearer token
   — no bespoke client-side header support needed. Reversible: no contract or other slice
   depends on the header name (spec §4/§6/§7 name neither).
2. **HTTP route: `POST /mcp`.** Chose this over any other path because nothing in the spec
   names one and the SDK's own examples use `/mcp`; internal to this gateway (client and
   server built together), so changing it later breaks nothing external.
3. **Rejection status: HTTP 401**, returned before the request body is parsed or handed to
   the MCP layer. Chose this over a JSON-RPC-shaped error on this path because HTTP has a
   native per-request auth signal (unlike stdio, which has none and therefore uses "no
   response at all" per spec §4); no AC or other slice depends on the exact status code, so
   it is a two-way door.
4. **Fresh `Server` + stateless `StreamableHTTPServerTransport` per request** (not one
   long-lived server/transport for the process). Chose this over a shared per-process
   server because HTTP-AC2 requires that rejecting one request never affects another
   caller sharing the same running process, and per-request isolation is the simplest way
   to guarantee that — the underlying `backendClient` (the expensive, stateful resource) is
   still connected once per process and shared, so this costs nothing extra per call; tool
   listing/allowlist logic is stateless, so rebuilding the `Server` wrapper is cheap.
5. **No default assumed for `PORT`.** Spec §7 documents no default for `PORT` (unlike
   `MCP_TRANSPORT`, which does have one) — `config.port` is `undefined` unless the caller
   sets it, and tests set it explicitly rather than relying on an invented value.

## 4. Evidence bundle

Raw output below is from a fresh, just-now run:

```
$ cd gateway && npm test
```

Full summary tail:

```
# tests 26
# suites 0
# pass 26
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5231.957426
```

Composition: 17 pre-existing `mcp-gateway-core` tests (6 gateway.integration + 1
core03-logging + 4 stdio-auth + 6 pre-existing unit) all still green — no regression — plus
3 new `loadConfig` unit tests for `transport`/`port` (legitimate slice work: config gained
these fields) plus 6 new HTTP integration tests = 26 total, 0 failures.

| Requirement | Evidence | Result |
|---|---|---|
| **HTTP-AC1** — valid credential + allowed tool proxied over HTTP, response structurally identical to backend's own, backend invoked exactly once. Failure behaviour: N/A per spec §HTTP-AC1 (this AC has no failure path — it *is* the success path). | Raw test output from `HTTP-AC1: a valid, allowlisted HTTP call is forwarded...`:<br>`direct:  {"content":[{"type":"text","text":"called:get_metric"}]}`<br>`gateway: {"content":[{"type":"text","text":"called:get_metric"}]}`<br>`calls-log: ["get_metric"]`<br>Test assertions: `assert.deepEqual(gatewayResult, directResult, ...)` and `assert.deepEqual(countCalls(callsLog), ['get_metric'], ...)`, both passed (`ok 11`). | PASS |
| **HTTP-AC2** — missing/mismatched credential rejected per-request (HTTP 401, pre-MCP-layer, backend never contacted), and rejection of one request doesn't affect a later valid request on the same process. | Failure path 1, no credential (`ok 8`):<br>`--- raw HTTP response: no credential ---`<br>`status: 401`<br>`body: {"error":"unauthorized"}`<br>marker file exists (backend process was spawned) but `countCalls(callsLog)` == `[]`.<br>Failure path 2, mismatched credential (`ok 9`):<br>`--- raw HTTP response: mismatched credential ---`<br>`status: 401`<br>`body: {"error":"unauthorized"}`<br>`countCalls(callsLog)` == `[]`.<br>Same-process sequencing proof (`ok 10`), (a) no-cred → 401, calls=[]; (b) bad-cred → 401, calls=[] (backend invocation count unchanged at zero after each rejection); (c) valid credential on the *same* running process:<br>`--- raw evidence: valid call after two rejections ---`<br>`{"content":[{"type":"text","text":"called:get_metric"}]}`<br>`calls-log contents after (c): ["get_metric"]`<br>— proving rejection is per-request, not a process-wide launch-time gate; the 401 gate fires before any request-body/method parsing, so this is method-independent (covers `initialize` and any other request kind, not only `tools/list`/`tools/call`). | PASS |
| **HTTP-AC3** — disallowed tool rejected with a standard MCP/JSON-RPC error object before the backend is contacted (backend invocation count stays 0); `tools/list` returns the same allowlist-filtered set on every call for the life of the process. | Failure path, disallowed call (`ok 12`):<br>`--- raw evidence: disallowed tool call error ---`<br>`{"stack":"McpError: MCP error -32601: MCP error -32601: Tool not available: delete_monitor\n ...","message":"MCP error -32601: MCP error -32601: Tool not available: delete_monitor","code":-32601,"name":"McpError"}`<br>`calls-log: []`<br>— a JSON-RPC error object with a numeric `code` (-32601, `MethodNotFound`) and non-empty `message`, not a bespoke HTTP shape, and backend invocation count is exactly 0.<br>`tools/list` stability (`ok 13`):<br>`--- raw evidence: tools/list called twice, unrelated call in between ---`<br>`first:  ["get_metric","search_logs"]`<br>`second: ["get_metric","search_logs"]`<br>— set-equal across two calls with an unrelated allowed `get_metric` call in between. | PASS |

Test names above map to the `ok N` lines in the raw `npm test` run: `ok 8`–`ok 13` are the
six new HTTP tests (HTTP-AC1 ×1, HTTP-AC2 ×3, HTTP-AC3 ×2); `ok 1`–`ok 7` and `ok 14`–`ok 26`
are the 17 pre-existing core tests plus the 3 new config unit tests, all green (no
regression).

## 5. Blocking spec defects

None. The spec handoff's §5 "Unresolved decisions" was already clean at handoff time, and
nothing encountered during implementation contradicted, left empty, or made non-evaluable
any of the three normalized requirements — every Class 3 choice needed to make them
concrete (header name, path, status code, per-request isolation strategy, no `PORT`
default) is recorded in §3 above with rationale, not escalated as a defect.
