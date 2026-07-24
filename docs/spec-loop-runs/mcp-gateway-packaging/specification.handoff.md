# Specification handoff: `mcp-gateway-packaging`

Input: `docs/SPECIFICATION.md` §3.3, §5, §7, §9 (AC7/AC8), plus the established
repo-root packaging conventions in `Dockerfile`, `dd-mcp-proxy.sh`,
`install.sh`, `.dockerignore`, and `mcp-datadog.example.json` (cited below as
Class 2 facts per the Gate 2 policy — investigated, not asked).

`mcp-gateway-core` (AC1–AC5) and `mcp-gateway-http` (AC6) are done. This slice
covers the remaining two acceptance criteria, AC7 and AC8, both traced to
**G3** ("same build is deployable both as a local Docker process and as a
standalone cloud-hosted service, with no code/config-format branching") and
**C4** ("Local and standalone-cloud deployments must share the same image and
environment-variable configuration schema; only secret injection may
differ").

## Gate 1 — Acceptance criteria

### PKG-01 (traces to AC7, G3, C4)

**Trigger** — A developer runs the documented build command
(`docker build ...` against the gateway's `Dockerfile`) followed by the
documented local-run command, copy-pasted verbatim from the docs — not
recalled from memory — with `MCP_TRANSPORT` unset or set to `stdio`.

**Preconditions** — Repo checked out at this slice; Docker available on the
build/run host; `GATEWAY_API_KEY` and `GATEWAY_CLIENT_KEY` (matching, per §6)
and `DD_API_KEY`/`DD_APP_KEY`/`DD_SITE` supplied exactly as the docs instruct
(e.g. via an env file, mirroring the `dd-mcp-proxy.sh` "load then forward only
named keys" pattern).

**Expected observable outcome** — `docker build` exits 0 and produces a
tagged, runnable image. Running the documented command starts the gateway
process attached over stdio; sending a real MCP `initialize` followed by a
`tools/call` for an allowlisted tool over that stdio stream returns a valid,
non-error MCP response — i.e. the packaged container reproduces the
already-verified AC1 stdio behaviour end-to-end, not merely "the process
started."

**Failure behaviour** —
- *Build-time:* the established `Dockerfile` pattern has no fail-on-missing
  build arg (`BASE_IMAGE`, `DOWNLOAD_BASE_URL`, `SHA256_AMD64`/`SHA256_ARM64`
  all carry defaults — Dockerfile lines 18–24), so a docs claim of "build
  fails if a build arg is omitted" would be false. What the existing
  convention actually fails fast on: a pinned-SHA256 mismatch aborts the
  build via `sha256sum --check --strict` (Dockerfile line 50), and an
  unsupported `TARGETARCH` exits non-zero with a message (Dockerfile line
  44). The gateway's own `Dockerfile` must preserve this fail-fast-on-tamper
  shape if it embeds a pinned binary the same way (see resolved unknown
  below); docs must describe this behaviour, not an invented "missing
  arg" failure.
- *Run-time:* per §6/C6 (established by `mcp-gateway-core`), a missing
  `GATEWAY_API_KEY` or a missing/mismatched `GATEWAY_CLIENT_KEY` means the
  process never serves any MCP traffic — it exits non-zero with the error on
  stderr only, never stdout (stdout is the reserved JSON-RPC channel). No MCP
  response is ever produced for that run.

**Verification method** — Not a unit test. Execute, on a clean checkout, the
build and run commands exactly as written in the docs (verbatim copy-paste,
so an omitted doc step fails the check); feed a real `initialize` +
`tools/call` pair over the container's stdio and capture the raw response.
Separately, rerun with `GATEWAY_API_KEY` unset and capture raw stdout/stderr
and exit code, confirming stdout is empty of the error and the process never
answers the MCP request within a bounded timeout (same race-style proof
`mcp-gateway-core` used for AC3). Both the happy path and the failure path
must be reproduced, not asserted.

### PKG-02 (traces to AC8, G3, C4)

**Trigger** — An operator runs the *same image artifact built for PKG-01*
(identical image digest/ID — not a rebuild) with `MCP_TRANSPORT=http`,
`PORT` set, and secrets injected via whatever mechanism the docs describe as
the standalone host's own (distinct from the local `.env`/compose
injection), following the documented steps verbatim.

**Preconditions** — The image digest produced in PKG-01's build is recorded
and is the one launched here (this is the mechanical proof of G3/C4's "same
build," not a courtesy assumption); only `MCP_TRANSPORT`, `PORT`, and the
secret-injection mechanism differ from PKG-01's invocation, per §5/§7's
env-var-only configuration schema.

**Expected observable outcome** — The container listens on the documented
port and a real `POST /mcp` request (mirroring `mcp-gateway-http`'s
established HTTP-AC1 check: valid credential, allowlisted tool, response
structurally equal to the backend's own response) succeeds. The docs contain
no step naming a specific cloud platform, host, or provider (per §3.2's
explicit exclusion of "selecting/provisioning the specific cloud hosting
platform") — every step is expressed only in terms of the image + env vars.

**Failure behaviour** — Reuses the already-established HTTP semantics rather
than inventing new ones: a missing/mismatched `Authorization: Bearer`
credential on a request gets `HTTP 401` before the backend is contacted
(§6, §9.1 AC6 HTTP-AC2); a missing `GATEWAY_API_KEY` at startup is the same
fail-fast-to-stderr, non-zero-exit, no-stdout-corruption behaviour as PKG-01
(the HTTP transport has no stdout constraint per C6, but the fail-fast-on-
misconfiguration behaviour itself is transport-independent). Docs must state
both explicitly so an operator isn't left guessing which failure they hit.

**Verification method** — Reproduce the documented standalone steps verbatim
against the exact image digest from PKG-01 (e.g. run it in a different
container/network namespace or non-dev host standing in for "standalone," to
avoid silently reusing local-run state); issue a real HTTP MCP call per the
docs and capture the raw response, confirming it is structurally identical
to the backend's own response (same bar as HTTP-AC1). Confirm the digest
used here matches PKG-01's build output byte-for-byte (`docker inspect
--format '{{.Id}}'` or equivalent), which is the actual evidence for "same
image, only secret injection differs" rather than an assumed precondition.
Separately reproduce the 401 failure path with a bad credential against the
same running container.

## Gate 2 — Gap-check and classification

Every unknown needed to fill the five fields above, classified per the
deterministic procedure (investigate → Class 1 test → Class 3 default):

| # | Unknown | Classification | Resolution |
|---|---|---|---|
| 1 | Does the gateway embed the `datadog_mcp_cli` binary in its own image, or does it shell out to `docker run` of the existing hardened image (docker-in-docker)? | **Class 2** | §4 states the gateway "connects, as an MCP client, to the real `datadog_mcp_cli` binary as a **child process** over stdio" — a child process, not a nested container. Docker-in-docker would additionally require mounting the host's Docker socket into the gateway container, which is itself a platform-specific deployment step and would break G3/C4's "same image, no branching" story for the standalone-cloud case (most hosts don't expose a Docker socket). The spec text plus this consequence for G3/C4 settle it: the gateway `Dockerfile` embeds the pinned-SHA256 `datadog_mcp_cli` binary directly, following the existing `Dockerfile`'s stage-1 download-and-verify pattern, rather than invoking `docker run`. **Carried forward for gate 4/Execute**: do not re-open this as a docker-in-docker option. |
| 2 | Does AC7's "documented compose/run command" require an actual `docker-compose.yml`, or is a plain documented `docker run` invocation sufficient? | **Class 3** | The spec itself offers "compose/run" as alternatives (§3.1), and the only existing local-launch convention in this repo (`dd-mcp-proxy.sh`) is a plain `docker run` wrapped in a shell script — no `docker-compose.yml` precedent exists anywhere in the repo. Chose a documented `docker run` command (optionally also a compose file) over mandating compose, because it follows the existing convention exactly and is a two-way door (a compose file can be added later without changing AC7's observable outcome). |
| 3 | Does AC8 require publishing the image to a registry, or CI wiring? | **Class 2** | §3.2 explicitly puts "selecting/provisioning the specific cloud hosting platform" out of scope, and registry choice is platform-specific. AC8's own text says "documented as deployable," not "published." Resolution: docs describe building/tagging the image and running it with the standalone env vars; registry-push mechanics are explicitly out of scope, not silently dropped. |
| 4 | Does the standalone deployment need a health-check endpoint? | **Class 3** | Not mentioned in §7's configuration schema or AC8's text, and many hosts work without one. Chose not to add one now: reversible (can be added as an additive, non-breaking route later), no contract impact on AC8 as literally stated, and adding unrequested surface area would itself be a silent assumption in the other direction. |
| 5 | Where do the packaging docs live (README section vs. a new file)? | **Class 3** | No existing convention dictates this (the repo has no `docs/DEPLOYMENT.md` yet and no packaging section in an existing README was found at repo root). Two-way door, no observable-behaviour or contract impact on AC7/AC8 as written — either location satisfies "documented." Left for gate 3/4 to place adjacent to the existing `dd-mcp-proxy.sh`/`mcp-datadog.example.json` docs pattern. |
| 6 | What is the correct build-time failure mode to cite for PKG-01's Failure behaviour? | **Class 2** | Investigated directly against `Dockerfile` lines 18–24 (build args all default — no fail-on-missing-arg exists) vs. lines 44 and 50 (unsupported `TARGETARCH` exits non-zero; SHA256 mismatch aborts via `sha256sum --check --strict`). Resolution recorded directly in PKG-01 above rather than inventing a "missing secret" failure mode that doesn't exist in the established pattern. |

**Exit-check:** zero criterion fields are empty; every classified item is
Class 2 (investigated, cited) or Class 3 (decided, rationale recorded); no
item met the Class 1 bar (externally observable/contract impact + one-way
door + genuine either/or) — none of the above changes AC7/AC8's observable
outcome, is a one-way door, or lacks a convention/spec answer. **No Class 1
questions are raised in this handoff.**

## Open questions

None raised. Per the autonomy override for this pass, every unknown was
resolved by investigation (Class 2) or a recorded safe choice (Class 3); no
genuine stakeholder decision was found. `docs/SPECIFICATION.md` §10 is not
edited by this handoff — that is gate 6's job, after verification, and only
if gate 5 surfaces a new discovery.
