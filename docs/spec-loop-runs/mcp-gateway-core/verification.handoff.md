# Verification handoff: `mcp-gateway-core`

Consumed `specification.handoff.md` and `implementation.handoff.md` as claims
only. Every command below was re-run from scratch against the actual repo
state at `./gateway/` (Node v22.15.0, no network, mock backend fixture
standing in for `datadog_mcp_cli`) rather than trusting the implementation
handoff's logged output.

## 1. Per-requirement verdict

| Requirement | Verdict | Check actually run | Observed result |
|---|---|---|---|
| CORE-01 — Launch-time shared-secret gate (stdio) | **PASS** | `node --test test/stdio-auth.test.js`, re-run standalone and again inside the full `npm test` run. Additionally manually exercised: `GATEWAY_CLIENT_KEY` unset and mismatched via `execFileSync`-style direct invocation, plus a real `Client.connect()` against the subprocess. | 4/4 tests pass on every run. Happy path: real MCP `Client.connect()` + `listTools()` succeeds and the backend marker file is written (backend spawn count = 1). Missing/mismatched key: `client.connect()` rejects within the 5s bound (`initialize` handshake never answered) and the marker file is never written (backend spawn count = 0), reproduced across repeat runs. |
| CORE-02 — Allowlist gates `tools/list`/`tools/call`, allowed calls proxied verbatim | **PASS** | `node --test test/gateway.integration.test.js`, re-run standalone and inside the full suite. Manually read `gateway.js`'s `CallToolRequestSchema` handler to confirm the forwarded-call path (`return result` with no transform) rather than trusting the handoff's structural claim. | 6/6 tests pass. Unset allowlist → full 3-tool backend set returned. Set allowlist → exactly the configured subset, stable across two `listTools()` calls with an unrelated `callTool()` in between (verification a/d). Allowed call → caller sees exactly the backend's own response, and source inspection confirms no transformation is applied (verification b). Disallowed call → caller gets a rejection and the fake backend's `calls` array stays empty — zero backend invocations (verification c). Backend-throws case (allowed call, backend itself errors) → caller's `callTool()` rejects with the backend's own message and the backend's `calls` array shows exactly one invocation, proving the error is relayed rather than success being fabricated (failure-behaviour clause). |
| CORE-03 — Per-call logging without caller identity or secrets | **PASS** | `node --test test/core03-logging.test.js`, re-run standalone and inside the full suite; independently confirmed no `console.*`/`process.stdout` writes exist anywhere in `gateway/src` (`grep -rn "console\.\|process\.stdout" src/` → no matches), so log lines cannot be interleaved into the MCP stdout channel. | 1/1 test passes. Raw captured stderr from the real subprocess shows exactly one entry each for `success` (`search_logs`), `failure` (`always_fails`, backend itself threw), and `rejected` (`delete_monitor`, allowlist-blocked before the backend was touched) — matching the three defined outcomes. Each entry's key set is exactly `{ts, tool, outcome, durationMs}` (asserted structurally, not by blocklisting guessed field names). A literal scan of the raw stderr for `GATEWAY_API_KEY`, `GATEWAY_CLIENT_KEY`, `DD_API_KEY`, `DD_APP_KEY`, and a distinct caller-identity marker value returns zero matches for all five, for all three outcomes. |

## 2. Missing evidence

None. All three requirements' evidence bundles were raw, reproducible command
output (not summaries), and every command was independently re-run here with
matching pass counts and matching observed behaviour (including the failure
paths — missing/wrong key, backend-thrown error, allowlist rejection — not
just the happy path).

## 3. Regressions

None found.

- Full suite (`npm test` = `node --test test/*.test.js test/**/*.test.js`):
  17/17 pass, matching the implementation handoff's claimed count, on
  multiple re-runs.
- Confirmed the deleted out-of-scope HTTP surface left no dangling
  reference: `grep -rn "server-http\|MCP_TRANSPORT" gateway/src gateway/test`
  → no matches.
- Confirmed no other file in the repo (`Dockerfile`, `install.sh`,
  `dd-mcp-proxy.sh`, `mcp-datadog.example.json`) references `gateway/` or the
  removed HTTP config surface — the slice's blast radius is contained to
  `gateway/`, so no broader-than-slice check was warranted.
- Manually probed a scenario the automated tests don't cover: launching the
  gateway with `GATEWAY_API_KEY` unset entirely (a config-load error, not the
  CORE-01 auth-check path, since CORE-01's own precondition assumes
  `GATEWAY_API_KEY` is configured). It throws an uncaught `Error` to stderr
  and exits 1, with zero bytes written to stdout — consistent with "never
  start the server transport," and not a regression since this path is
  explicitly outside CORE-01's precondition.
- Manually probed stdout purity on the happy path (gateway running idle with
  no client request): zero bytes on stdout, confirming logging cannot ever
  corrupt the MCP protocol stream even outside the exact scenarios the tests
  exercise.

## 4. Classified failures

None. No failure was observed against any of the three requirements across
happy-path and failure-path exercise, so the six-type classification table
has nothing to route.

## 5. Overall verdict

**PASS.** All three requirements (CORE-01, CORE-02, CORE-03) are PASS with
evidence reproduced directly against the current repo state — command output
was re-run, not read from the implementation handoff's log — the failure
behaviour was exercised for each requirement (not just the happy path), and
no regression was found within the slice's blast radius or beyond it.
