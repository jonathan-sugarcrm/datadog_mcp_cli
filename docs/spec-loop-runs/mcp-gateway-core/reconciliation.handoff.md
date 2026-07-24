# Reconciliation handoff: `mcp-gateway-core`

Verification's overall verdict was **PASS** (CORE-01/02/03 all PASS, zero
classified failures, zero regressions). No defect required a code fix or a
spec-contradiction fix. Reconciliation's job on a clean pass is to fold the
implementation's Class 2/3 discoveries — safe choices and facts recorded
only in the handoffs — back into `SPECIFICATION.md` so the durable contract
matches what was actually built, and to tighten §9 now that concrete
verification methods exist for AC1–AC5.

## 1. Spec edits made

| Section | What changed | Which finding it answers |
|---|---|---|
| §4 Architecture & wiring | Added bullet: backend child process env is a narrow allowlist (`DD_API_KEY`/`DD_APP_KEY`/`DD_SITE` only); gateway's own shared secrets are never forwarded. | Implementation handoff §3 decision log — "Chose to forward only DD_API_KEY/DD_APP_KEY/DD_SITE... to the backend child process, over forwarding this process's entire env." Concretizes C1 for the backend-process boundary. |
| §4 Architecture & wiring | Added bullet: a disallowed `tools/call` (AC2) is rejected with a standard MCP/JSON-RPC error object (code + message) — defines "a clear error" for AC2 only, and explicitly notes AC3's stdio invalid-key case has no error object (process refusal, not a served rejection), so it doesn't contradict §6/§9.1. | Implementation handoff §3 decision log — "Chose a standard McpError/ErrorCode.MethodNotFound... because the handoff's decision log explicitly calls for a standard MCP/JSON-RPC error object." Previously §9 AC2's "clear error" was unspecified prose; original draft of this edit over-scoped the bullet to AC3 too and was corrected after an advisor pass caught the contradiction with §6's "process never comes up to serve requests." |
| §6 Security model | Added bullet: `outcome` field takes exactly one of `success`/`failure`/`rejected`. | Specification handoff §6 Class 3 choice ("outcome enum `success`/`failure`/`rejected`") — was recorded only in the slice handoff, not in the durable spec. Also tightens §9 AC5. |
| §6 Security model | Added bullet: stdio log output must go to stderr, never stdout (stdout is the MCP JSON-RPC channel). | Implementation handoff §3 decision log — moving `logCall` from stdout to stderr was flagged as "a correctness fix, not a style preference: the scratch code's stdout logging would have broken CORE-01/02's own transport under real use." This is a real technical constraint discovered during implementation, previously undocumented. |
| §6 Security model | Added bullet: `GATEWAY_API_KEY` unset entirely is a config-load error (fail-fast, stderr, exit non-zero, zero stdout bytes) — distinct from the AC3 auth-check path. | Verification handoff §3 Regressions — manually probed scenario outside the automated tests' scope; worth recording so a later slice doesn't reintroduce ambiguity about this boundary. |
| §8 Constraints | Added **C6**: stdio log output must never reach stdout; stderr or another out-of-band sink only. Explicitly scoped to stdio (does not apply to `mcp-gateway-http`). | Same discovery as the §6 stdout/stderr bullet above — routed as *New technical constraint discovered → update Constraints* per the six-type table. |
| §9 Acceptance criteria | Added **§9.1 "Verification methods established by `mcp-gateway-core`"** — one line per AC1–AC5 stating the concrete bounded/structural check now proven (equality-not-just-error-code for AC1/AC2, bounded-timeout race for AC3, ≥2-call stability for AC4, raw-capture-and-grep for AC5). | Direct instruction to tighten §9 now that concrete verification methods exist (implementation handoff §4 Evidence bundle + verification handoff §1 per-requirement checks). Prevents a future slice from regressing to a weaker check that would still pass a green test (the "test passes but outcome unmet" trap). |
| §10 Open questions | Added one sentence noting no new product decisions were surfaced; everything was Class 2/3 and is now folded into §4/§6/§8/§9. | Closes the loop explicitly — confirms nothing was left only in a handoff or chat. |
| §3.3 (pass pointer) | Changed "This pass targets `mcp-gateway-core`" to "`mcp-gateway-core` is done (AC1–AC5 verified PASS). This pass targets `mcp-gateway-http`." | Reconciliation is the only stage that can edit `SPECIFICATION.md`, so advancing the pointer to the next slice (§4 below) has to happen here — otherwise the durable spec would keep pointing at a finished slice until the next reconciliation pass. |

No section was added that didn't already exist; all edits are additions to
existing bullets/tables within §4, §6, §8, §9, §10. No new design docs were
created.

## 2. Defects folded

| Verification finding | Where it landed in the spec |
|---|---|
| None — verdict was PASS, zero classified failures, zero regressions. | N/A |

Although there were no *defects*, the table below tracks the *discoveries*
(safe choices / facts) that were folded per gate 6's mandate that every
result move code or spec, even on a clean pass:

| Discovery (source) | Landed in |
|---|---|
| Backend env passthrough is a narrow allowlist (impl. handoff §3) | §4 |
| Standard MCP/JSON-RPC error object for rejections (impl. handoff §3) | §4 |
| `outcome` enum is exactly `success`/`failure`/`rejected` (spec handoff §6) | §6, §9.1 |
| stdout must never carry log output on stdio (impl. handoff §3) | §6, §8 (C6) |
| `GATEWAY_API_KEY` unset = config-load error, not AC3 path (verification handoff §3) | §6 |
| Concrete bounded/structural verification methods for AC1–AC5 (impl. + verification handoffs) | §9.1 |

## 3. Loop routing

| Item | Classification | Action taken |
|---|---|---|
| Backend env allowlist | New technical constraint discovered (already implied by C1; concretized) | Folded into §4 (wiring detail), no new `C*` needed — C1 already covers "never expose/log the Datadog credential"; this just names the mechanism. |
| Standard MCP/JSON-RPC error shape | Requirement was under-specified ("a clear error") | §9's AC2 ambiguity resolved by adding the concrete shape to §4, scoped to AC2 only (AC3's stdio case has no error object — process refusal instead, per §6/§9.1) — treated as "requirement cannot be verified → add evidence criteria," now closed by the §9.1 addition referencing the equality/zero-invocation check, and by §4's error-shape bullet. |
| `outcome` enum values | Behaviour was unspecified in the durable spec (only in the slice handoff) | Folded into §6 + §9.1 — moved out of the ephemeral handoff into the durable contract, per "every discovery lands in the spec." |
| stdout/stderr log-channel constraint | New technical constraint discovered | Added **C6** to §8, plus a §6 bullet. |
| `GATEWAY_API_KEY`-unset behaviour | Behaviour was unspecified (edge case outside AC3's stated precondition) | Folded as a clarifying §6 bullet rather than left as an open question — it's a Class 2 fact (investigated and observed), not a stakeholder decision, so it does not go to §10. |
| Weak verification methods for AC1–AC5 | "Test passes but outcome unmet" risk (a future weaker test could still pass a vague AC) | Added §9.1 to lock in the stronger checks already proven, per gate 1/§9 "improve the verification method." |

No item required routing to gate 4 (code fix) or gate 1 (spec contradiction)
— everything routed to a spec-tightening edit. The loop is closed: every
verification finding and implementation discovery moved into
`SPECIFICATION.md`; nothing remains only in a handoff or chat.

## 4. Next slice

**`mcp-gateway-http`** — per §3.3's backlog, it depends only on
`mcp-gateway-core` (now done) and is a genuinely thin delta: reuse the
existing allowlist/proxy/logging logic untouched, add the Streamable HTTP
transport and per-request header-based auth (already specified in §6's
"Product decision (resolved)" paragraph — the HTTP auth model was decided
alongside the stdio one, not left open). The core slice's implementation
deliberately deleted the prior scratch HTTP code as out-of-scope rather than
leaving it inert, so `mcp-gateway-http` starts clean with no salvage
decisions to make. One thing for gate 1 of that slice to note explicitly:
**C6 (stdout/stderr log-channel constraint) does not apply to HTTP** — the
spec now says this directly, so the HTTP slice's gate 2 doesn't need to
re-investigate it.
