# Reconciliation handoff: `mcp-gateway-http`

Input consumed: `docs/spec-loop-runs/mcp-gateway-http/verification.handoff.md` and
`docs/spec-loop-runs/mcp-gateway-http/verification.report.yaml` (overall verdict: **PASS**,
zero classified failures, one non-blocking missing-evidence note). `docs/SPECIFICATION.md`
was read and edited; no code or test file was touched.

## 1. Spec edits made

| Section | What changed | Which finding it answers |
|---|---|---|
| §3.3 | "`mcp-gateway-core` is done (AC1–AC5 verified PASS). This pass targets `mcp-gateway-http`." → "`mcp-gateway-core` and `mcp-gateway-http` are done (AC1–AC5 and AC6 verified PASS). This pass targets `mcp-gateway-packaging`." | Overall PASS verdict; advances the slice pointer. |
| §4 (Architecture & wiring) | Added a new bullet, "HTTP wiring (established by `mcp-gateway-http`)": credential header `Authorization: Bearer <key>`, route `POST /mcp`, `HTTP 401` returned before body parsing/MCP layer, and the fresh-`Server`-+-stateless-transport-per-request design (with `backendClient` shared once per process) that gives HTTP-AC2's per-request isolation. Noted these are two-way doors nothing else depends on. | Decision log items 1–4 (header name, route, status code, per-request isolation) — durable architecture facts, not left only in the implementation handoff. |
| §6 (Security model) | Replaced the forward-looking "Over HTTP (later slice), the credential is presented per-request in a header..." sentence with the concrete, now-implemented facts: `Authorization: Bearer <key>` header, checked before body parsing, `HTTP 401` on mismatch/missing, backend never contacted for that request, and cross-referenced §9.1 AC6 for the same-process non-interference proof. | Same decision-log facts, security-relevant framing. |
| §9 (intro sentence) | "slice `mcp-gateway-core` covers AC1–AC5. AC6–AC8 belong to later slices (`mcp-gateway-http`, `mcp-gateway-packaging`)." → "slice `mcp-gateway-core` covers AC1–AC5 (verified PASS) and slice `mcp-gateway-http` covers AC6 (verified PASS). AC7–AC8 belong to the remaining slice (`mcp-gateway-packaging`)." | Marks AC6 verified PASS, mirroring how AC1–AC5 were marked for `mcp-gateway-core`. |
| §9.1 (heading + intro) | Retitled to "Verification methods established by `mcp-gateway-core` and `mcp-gateway-http`"; intro now says "sharpen AC1–AC6" instead of "AC1–AC5". | Extends the sharpened-verification-method pattern to the new slice. |
| §9.1 (new bullet) | Added an **AC6** bullet sharpening it into the three HTTP-AC checks actually proven (structural response equality + exactly-one-invocation for HTTP-AC1; per-request 401 gate + same-process non-interference for HTTP-AC2; standard JSON-RPC error object + zero invocations + `tools/list` stability for HTTP-AC3). Includes a **"Known non-blocking gap"** clause naming the untested "no allowlist configured" branch over HTTP. | Fulfils "add a §9.1-style verification-methods entry for HTTP-AC1/2/3" and folds in the one missing-evidence note from verification §2. |
| §10 (Open questions) | Extended the closing sentence to also cover `mcp-gateway-http`, explicitly naming the Class 3 choices and the one non-blocking evidence gap as already folded into §4/§6/§9.1, so §10 stays "None" rather than gaining a false open question. | Decision documented below (§3 of this handoff). |

§7 (Configuration table) was checked but **not edited** — `PORT` and `MCP_TRANSPORT` were
already present as rows (they were pre-declared for this slice by the specification
handoff before implementation) and their descriptions already match what shipped
(`stdio`/`http` default, HTTP-transport-only port). No credential-header row was added to
§7 because the header carries no new secret — it carries the existing `GATEWAY_API_KEY`
value — so it is a security-model fact (§6), not a new configuration variable.

## 2. Defects folded

| Verification finding | Where it landed |
|---|---|
| HTTP-AC1 PASS (structural equality, exactly-one-invocation) | §9.1 AC6(a) |
| HTTP-AC2 PASS (401 before backend/parsing, per-request, same-process non-interference) | §9.1 AC6(b); §4 and §6 wiring bullets |
| HTTP-AC3 PASS (JSON-RPC error object, zero invocations, `tools/list` stability) | §9.1 AC6(c) |
| Decision log #1–3: header name, route, status code (Class 3, two-way doors) | §4 "HTTP wiring" bullet; §6 |
| Decision log #4: per-request `Server`+transport isolation | §4 "HTTP wiring" bullet |
| Decision log #5: no invented default for `PORT` | Already covered by §7's existing wording ("HTTP transport only", no default value stated) — no edit needed |
| Missing evidence: HTTP-AC1 "no allowlist" branch untested directly over HTTP (non-blocking) | §9.1 AC6 "Known non-blocking gap" clause |
| Regressions: none; core files byte-for-byte unchanged | No spec change needed — confirms §4/§6 stdio facts already on record still hold; nothing to fold in |

## 3. Loop routing

No classified failures were reported (verification §4: "None"), so no code-fix or
spec-fix routing is required under the six-type table. Every result from the
verification handoff moved into the spec:

- Three PASS verdicts (HTTP-AC1/2/3) → new §9.1 AC6 entry + §4/§6 wiring facts (code
  already reflects this; spec now documents it — loop closed on the spec side).
- Decision log's Class 3 choices → §4/§6 (durable architecture/security facts recorded).
- The one missing-evidence note → treated as a **documented known gap**, not a Class 1
  "unspecified behaviour" open question, because nothing about the *product's* required
  behaviour is ambiguous — the spec's own precondition ("or no allowlist is configured")
  is already stated and already covered by existing stdio/unit tests; only a *dedicated
  HTTP integration test* is missing. That is a test-suite completeness gap, not a spec
  gap, so it was recorded as a caveat inside the §9.1 AC6 verification-method entry
  (visible to whoever revisits AC6) rather than added to §10. It does not block AC6's
  verified-PASS status per the verification handoff's own reasoning.
- No regressions, no spec/implementation defects were found, so no §10 entry, §8
  constraint change, or §9 criterion rewrite was triggered by this pass beyond what is
  listed above.

The loop is closed: every verification finding moved the spec (no code changes were made
or needed, since verification found zero classified failures).

## 4. Next slice

**`mcp-gateway-packaging`** — per §3.3's thin-delta backlog, it is the only remaining
slice (depends on `mcp-gateway-http`, now done) and covers the two remaining acceptance
criteria, AC7 (single Docker image runnable locally via documented compose/run) and AC8
(same image documented as deployable as a standalone hosted service using the same
env-var schema). §3.3's pointer in `docs/SPECIFICATION.md` has been advanced to target it.
