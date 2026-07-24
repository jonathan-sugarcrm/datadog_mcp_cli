# Verification handoff: `mcp-gateway-http`

Input consumed: `docs/spec-loop-runs/mcp-gateway-http/specification.handoff.md` (the
criteria and Verification methods) and `docs/spec-loop-runs/mcp-gateway-http/implementation.handoff.md`
(treated as claims only). Both were re-derived against the actual repo state at
`gateway/src` and `gateway/test`, not trusted. Every check below was personally run in
this session; the implementation handoff's logged output was not reused as evidence.

## 1. Per-requirement verdict

| Requirement | Verdict | Check actually run | Observed result |
|---|---|---|---|
| **HTTP-AC1** — valid credential + allowed tool proxied over HTTP, response structurally identical to backend's own, backend invoked exactly once. | **PASS** | Re-ran `cd gateway && npm test` (full suite, fresh install). Test `ok 11` (`HTTP-AC1: a valid, allowlisted HTTP call is forwarded...`) drives a real gateway subprocess over a real TCP socket and a direct stdio call to the same mock backend for comparison. | `direct: {"content":[{"type":"text","text":"called:get_metric"}]}` / `gateway: {"content":[{"type":"text","text":"called:get_metric"}]}` — `assert.deepEqual` passed; `calls-log: ["get_metric"]` (exactly one invocation). Reproduced verbatim in this session's own run, not copied from the implementation handoff. |
| **HTTP-AC2** — missing/mismatched credential rejected per-request (HTTP 401, pre-MCP-layer, backend never contacted); rejection of one request does not affect a later valid request on the same process. | **PASS** | (a) Re-ran `npm test` — `ok 8`, `ok 9`, `ok 10` all green. (b) Manually probed beyond the automated tests: started the real gateway subprocess (`MCP_TRANSPORT=http`, `GATEWAY_API_KEY=expected-secret`, mock backend with a calls-log) and hit it with raw `curl`, bypassing the MCP SDK client entirely, for four cases: no `Authorization` header, a header without the `Bearer ` prefix, a wrong-credential request with a garbage (non-JSON) body, and finally a valid-credential `initialize` request on the same running process. | Raw wire bytes for probes 1–3: `HTTP/1.1 401 Unauthorized` + body `{"error":"unauthorized"}` in all three cases. The load-bearing proof that the backend is never contacted on these probes is the 401 itself, returned by `sendUnauthorized(res); return;` in `gateway/src/server-http.js` — a code path that returns before `backendClient` (and the request handler that would invoke it) is ever reached, corroborated by these probes all using `method: "tools/list"`, whose handler (`ListToolsRequestSchema`) never appends to the calls-log even on success — so an empty calls-log on probes 1–3 does not by itself discriminate "never contacted" from "contacted but not logged"; the 401 return path is what proves it. Probe 3 (garbage body + wrong credential) still 401'd — proving the 401 fires before the request body is parsed, so rejection is method-independent (covers `initialize` and any other request kind, not just `tools/call`), consistent with the spec's "any request kind" language. Probe 4 (valid credential, `initialize`, same process, after the three prior rejections) returned `HTTP/1.1 200 OK` with a normal `initialize` result — proving a later valid request on the same process is unaffected by earlier rejections. The automated test `ok 10` (`HTTP-AC2: rejection...same process`) is where the calls-log genuinely discriminates: its step (c) issues a `tools/call`, and the calls-log goes from `[]` to `["get_metric"]`, a real 0→1 proof of exactly one backend invocation. The mock backend's startup marker file existed throughout every probe (the backend child process is spawned once at gateway startup, per HTTP-AC1's precondition) — that marker proves only that the child process exists, not that it was ever invoked; it is not in tension with the 401/calls-log evidence above. |
| **HTTP-AC3** — disallowed tool rejected with a standard MCP/JSON-RPC error object before the backend is contacted (invocation count stays 0); `tools/list` returns the same allowlist-filtered set on every call for the life of the process. | **PASS** | (a) Re-ran `npm test` — `ok 12`, `ok 13` green. (b) Manually probed beyond the SDK-mediated test: raw `curl` `tools/call` for a disallowed tool (`delete_monitor`) with a valid credential, statelessly (no prior `initialize` handshake), against a running gateway with `MCP_ALLOWLIST=get_metric`. | Automated test `ok 12` only asserts `typeof caught.code === 'number'` on the SDK's parsed `McpError` — that inspects the *client's* interpretation, not the wire. The raw-curl probe is the stronger, un-mediated proof: response body was exactly `{"jsonrpc":"2.0","id":3,"error":{"code":-32601,"message":"MCP error -32601: Tool not available: delete_monitor"}}` — a standard JSON-RPC error object (top-level `error.code` + `error.message`), not a bespoke HTTP-shape error, and the gateway's own log line confirms `{"tool":"delete_monitor","outcome":"rejected",...}`. `calls-log` stayed empty. `tools/list` stability (`ok 13`): `first: ["get_metric","search_logs"]`, `second: ["get_metric","search_logs"]` across two calls with an unrelated allowed `get_metric` call in between — set-equal. |

## 2. Missing evidence

- **HTTP-AC1's alternative precondition ("no allowlist configured") is untested over HTTP.**
  The spec's precondition for HTTP-AC1 is "the target tool is in `MCP_ALLOWLIST` (or no
  allowlist is configured)." The only HTTP-AC1 test (`ok 11`) sets `MCP_ALLOWLIST=get_metric`
  and calls an allowlisted tool; no HTTP test exercises the "no allowlist at all" branch.
  This is **not a blocking gap** — the criterion's stated Verification method only requires
  "present a valid credential and call an allowlisted tool," which was reproduced — but the
  unallowlisted-over-HTTP path is covered only transitively (the `filterTools`/`buildGatewayServer`
  code path is shared and unit-tested with `allowlist: null` in `gateway/test/unit.test.js`,
  and proven directly over stdio in `mcp-gateway-core`'s `ok 2`), not by a dedicated HTTP
  integration test. Logged here rather than silently dropped; does not change the HTTP-AC1
  verdict because the stated method was satisfied.
- No other requirement's stated Verification method was left unreproduced. All three
  criteria's happy-path and failure-path behaviour were exercised both by the automated
  suite (re-run fresh in this session) and by manual raw-HTTP probes independent of the
  MCP client SDK.

## 3. Regressions

**None found.**

- Re-ran the full suite (`cd gateway && npm test`): **26/26 pass, 0 fail** — matches the
  claimed count, but was independently reproduced rather than trusted.
- Of the 26, 17 are the pre-existing `mcp-gateway-core` tests: 6 in
  `gateway.integration.test.js`, 1 in `core03-logging.test.js`, 4 in `stdio-auth.test.js`,
  6 pre-existing in `unit.test.js` (verified by `grep -c "^test("` against each file and
  cross-checked against `git diff HEAD` — `unit.test.js` gained exactly 3 new tests, for
  9 total). All 17 pre-existing tests are green in this run.
- Strongest regression proof: `git diff HEAD --stat -- gateway/src/gateway.js gateway/src/auth.js gateway/src/logger.js gateway/src/server-stdio.js`
  produced **zero output** — these four files are byte-for-byte unchanged from the
  `mcp-gateway-core` commit. The stdio path is not merely "tested and green," it is
  provably untouched code; HTTP support was added by a new `server-http.js` that imports
  `buildGatewayServer`/`connectBackend` from the existing `gateway.js`, plus a dispatch
  branch in `index.js` and two new fields in `config.js`.
- Blast-radius check: `git status --porcelain` shows only `gateway/src/config.js`,
  `gateway/src/index.js`, `gateway/test/fixtures/mock-datadog-server.js`,
  `gateway/test/unit.test.js` modified; `gateway/src/server-http.js` and
  `gateway/test/http.test.js` added; plus the `docs/spec-loop-runs/mcp-gateway-http/`
  handoff docs. Nothing outside `gateway/` (and its own docs run folder) was touched —
  `package.json`/`package-lock.json`, `Dockerfile`, `install.sh`, `dd-mcp-proxy.sh`,
  `mcp-datadog.example.json`, and `docs/SPECIFICATION.md`/`docs/SPEC_LOOP.md` are all
  untouched. No new dependency was added (`package.json` diff is empty); the SDK's
  `streamableHttp.js` client/server modules used by the new code already existed in the
  installed `@modelcontextprotocol/sdk@^1.29.0`.

## 4. Classified failures

**None.** No defect was found in code, spec, or verification model for this slice.

## 5. Overall verdict

**PASS.**

All three gate-1 criteria (HTTP-AC1, HTTP-AC2, HTTP-AC3) have a PASS backed by evidence
reproduced independently in this session: a fresh `npm test` run (26/26, matching the
implementation handoff's claimed count but not trusted on that basis alone) plus manual
raw-HTTP probes (via `curl`, bypassing the MCP client SDK) exercising the failure paths for
HTTP-AC2 and HTTP-AC3 beyond what the automated tests show. No regression was found in the
pre-existing 17 `mcp-gateway-core` tests, and the four core files
(`gateway.js`/`auth.js`/`logger.js`/`server-stdio.js`) are proven byte-for-byte unchanged.
Blast radius is confined to `gateway/` plus this run's own docs folder; no unrelated files,
dependencies, or configuration were touched. One non-blocking evidence gap is logged in §2
(no dedicated HTTP test for the "no allowlist configured" branch of HTTP-AC1) but does not
change the verdict, since the stated Verification method for HTTP-AC1 does not require that
branch to be exercised.
