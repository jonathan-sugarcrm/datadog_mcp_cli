# Verification handoff: `mcp-gateway-packaging`

Input consumed: `docs/spec-loop-runs/mcp-gateway-packaging/specification.handoff.md`
(PKG-01/PKG-02 criteria and Verification methods) and
`docs/spec-loop-runs/mcp-gateway-packaging/implementation.handoff.md` (treated as claims
only, not trusted). Every check below was independently reproduced in this session against
the actual repo state (`gateway/Dockerfile`, `gateway/.dockerignore`, `gateway/README.md`,
`gateway/src`, `gateway/test`) — the implementation handoff's logged output/digests were not
reused as evidence, only as a target to compare against.

## 1. Per-requirement verdict

| Requirement | Verdict | Check actually run | Observed result |
|---|---|---|---|
| **PKG-01 happy path** — `docker build` exits 0; documented stdio run (verbatim flags, including `--read-only`/tmpfs/cap-drop/etc.) + a real `initialize`/`tools/call` returns a valid, non-error MCP response. | **PASS** | Ran `docker build --no-cache -t datadog-mcp-gateway-verify:nocache -f gateway/Dockerfile gateway` from this session (a true from-scratch build, not reusing any cached layer from the implementation session) — build log shows the `downloader` stage's real `curl` fetch, `sha256sum --check --strict` pass, and ELF-magic check pass, then exit 0 producing image `sha256:d6485c2cd4794d43c519c82b366352a30ab8731a9522a5b08afddf743f039324`. Then drove a real MCP `Client`/`StdioClientTransport` (from the repo's own installed `@modelcontextprotocol/sdk`) spawning `docker run --rm -i -e GATEWAY_API_KEY=expected-secret -e GATEWAY_CLIENT_KEY=expected-secret -e BACKEND_COMMAND=node -e BACKEND_ARGS=/app/mock-backend.js -v <fixture>:/app/mock-backend.js:ro --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m datadog-mcp-gateway-verify:nocache` — the README's documented flags verbatim, substituting the repo's own `test/fixtures/mock-datadog-server.js` as backend (no real Datadog credentials exist in this sandbox — see §2 disclosure). | `SERVER_INFO: {"name":"datadog-mcp-gateway","version":"0.1.0"}` / `TOOLS_LIST: ["search_logs","get_metric","delete_monitor","always_fails"]` / `TOOLS_CALL_RESULT: {"content":[{"type":"text","text":"called:search_logs"}]}` — a real, non-error MCP response under the hardened, `--read-only` flag set. |
| **PKG-01 failure path (run-time)** — missing `GATEWAY_API_KEY` ⇒ non-zero exit, error on stderr only, stdout empty, no MCP response within a bounded timeout. | **PASS** | (a) `docker run --rm -i --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m datadog-mcp-gateway-verify:nocache < /dev/null`, stdout/stderr captured to separate files. (b) A real MCP `Client.connect()` (same SDK, `StdioClientTransport` spawning `docker run --rm -i datadog-mcp-gateway-verify:nocache`, no `GATEWAY_API_KEY`) with a 5000 ms bound. | (a) Exit code `1`. stdout: 0 bytes. stderr: `Error: GATEWAY_API_KEY is required (the shared secret clients must present)` + stack trace, nothing else. (b) `connect()` rejected in **853 ms** (well inside the 5000 ms bound) with `MCP error -32000: Connection closed` — the handshake never completed, no MCP response was ever produced. |
| **PKG-01 failure path (build-time)** — a pinned-SHA256 mismatch aborts `docker build` via `sha256sum --check --strict`. | **PASS — reproduced, not merely docs-checked** | `docker build --no-cache --build-arg SHA256_AMD64=0000000000000000000000000000000000000000000000000000000000000000 -f gateway/Dockerfile gateway`, with the real `curl` fetch of the real binary left intact (only the expected-hash `ARG` was tampered with) and the process's own exit code captured separately from the piped log's exit status. | `sha256sum --check --strict` reported `/tmp/datadog_mcp_cli: FAILED` / `sha256sum: WARNING: 1 computed checksum did NOT match`; BuildKit aborted with `ERROR: failed to solve: process ... did not complete successfully: exit code: 1`; the real `docker build` process's own exit code (captured directly, not read off the tailed log) was **1**. This closes the gap the first evidence pass left: the happy-path build log only proves the check *runs* (`OK`); this proves it *aborts on mismatch*, per SPEC_LOOP's "the failure behaviour too" rule. |
| **PKG-02 happy path** — the *same image digest* run standalone with `MCP_TRANSPORT=http`, `PORT` set, secrets via env vars only, no named cloud platform; a real `POST /mcp` succeeds with a response structurally equal to the backend's own. | **PASS** | `docker inspect --format '{{.Id}}' datadog-mcp-gateway-verify:nocache` → `sha256:d6485c2c...` (the exact PKG-01 build digest — no rebuild). Launched `docker run -d --rm -e GATEWAY_API_KEY=standalone-secret -e MCP_TRANSPORT=http -e PORT=8080 -e BACKEND_COMMAND=node -e BACKEND_ARGS=/app/mock-backend.js -v <fixture>:/app/mock-backend.js:ro -p 18080:8080 datadog-mcp-gateway-verify:nocache`; `docker inspect --format '{{.Image}}' <container id>` → `sha256:d6485c2c...`, identical to the tag's `Id` above. Drove a real `StreamableHTTPClientTransport` `initialize` + `tools/list` + `tools/call` against `http://localhost:18080/mcp` with `Authorization: Bearer standalone-secret`. | Digest match confirmed byte-for-byte (`d6485c2cd4794d43c519c82b366352a30ab8731a9522a5b08afddf743f039324` both times — this is the actual "same image, only secret injection/transport env differ" proof, not an assumed precondition). HTTP response: `SERVER_INFO: {"name":"datadog-mcp-gateway","version":"0.1.0"}` / `TOOLS_LIST: [...]` / `TOOLS_CALL_RESULT: {"content":[{"type":"text","text":"called:search_logs"}]}` — structurally identical to the mock backend's own stdio response and to PKG-01's own `TOOLS_CALL_RESULT`. |
| **PKG-02 failure paths** — bad/missing `Authorization: Bearer` ⇒ `HTTP 401` before backend contact, isolated per-request; missing `GATEWAY_API_KEY` at HTTP startup ⇒ same fail-fast-to-stderr/non-zero-exit as PKG-01. | **PASS** | Against the running PKG-02 container: `curl -i -X POST http://localhost:18080/mcp -H 'Authorization: Bearer wrong-secret' ...` and, separately, the same request with the `Authorization` header omitted entirely. Then, after both rejections, re-ran the PKG-02 happy-path client again against the same still-running process to confirm isolation. Finally: `docker run --rm -e MCP_TRANSPORT=http -e PORT=8080 datadog-mcp-gateway-verify:nocache` with no `GATEWAY_API_KEY`. | Both bad-credential probes: raw `HTTP/1.1 401 Unauthorized` / `{"error":"unauthorized"}`. Isolation check: the same valid-credential client call succeeded identically (`SERVER_INFO`/`TOOLS_LIST`/`TOOLS_CALL_RESULT` unchanged) after the two 401s — one caller's rejection did not affect a later valid request on the same process. Missing-`GATEWAY_API_KEY` HTTP startup: exit code `1`, stdout 0 bytes, stderr `Error: GATEWAY_API_KEY is required (the shared secret clients must present)` — identical error shape to the PKG-01 stdio failure path. |
| **Self-caught defect — writable XDG dirs under `--read-only`** (decision-log #7 in the implementation handoff). | **PASS, independently confirmed, not taken on the handoff's word** | Ran `docker run --rm --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --entrypoint node datadog-mcp-gateway-verify:nocache -e "<script writing to $XDG_CONFIG_HOME/$XDG_DATA_HOME/$XDG_CACHE_HOME>"` against the actual final image. Then built a deliberately-regressed variant (`gateway/Dockerfile` with the `VOLUME ["/home/node"]` line stripped, everything else identical) and repeated the same write probe against it, to prove the fix is load-bearing rather than a no-op. | Final image: `WRITE_OK config` / `WRITE_OK data` / `WRITE_OK cache` — all three XDG dirs are genuinely writable under `--read-only` (via the anonymous volume `VOLUME ["/home/node"]` declares). Stripped-VOLUME variant: `WRITE_FAIL config EROFS: read-only file system, open '/home/node/.config/testfile'` — confirms the fix is real and necessary, not cosmetic; the described defect would actually reproduce without it. |

## 2. Note on the mock-backend substitution (independently assessed, not just repeated)

No real `DD_API_KEY`/`DD_APP_KEY` exist in this sandbox, matching the implementation
handoff's own disclosure. The evidence above reuses the same substitution
(`BACKEND_COMMAND=node BACKEND_ARGS=/app/mock-backend.js`, bind-mounting the repo's own
`gateway/test/fixtures/mock-datadog-server.js` into the container) — a real, separate MCP
stdio server process, not a stub injected into the gateway's own code path. This proves the
packaged gateway's stdio/HTTP transport, auth gate, child-process spawn, and tool
forwarding end-to-end inside the actual built container. It does **not** prove the embedded
`datadog_mcp_cli` binary successfully authenticates to Datadog's live API — that remains
out of scope for this packaging slice (AC1–AC6 already cover the gateway's own logic; the
binary's integrity was independently confirmed by this session's own `--no-cache` build,
whose `downloader` stage re-ran the real `curl` fetch against
`https://coterm.datadoghq.com/mcp-cli/...` and passed `sha256sum --check --strict` against
the pinned hash, live in this session — not merely re-asserted from a cached layer).

## 2b. Non-blocking observation: hardening-flag asymmetry between the two documented run examples

`gateway/README.md`'s stdio run example includes `--read-only`, `--tmpfs`, `--cap-drop=ALL`,
`--security-opt=no-new-privileges`, `--pids-limit`, and `--memory`; the HTTP run example
includes none of them. This is **not** a PKG-02/C4 violation — C4 governs the image and the
environment-variable configuration schema, and these are `docker run` isolation flags, not
env vars or image contents. Checked, not assumed: re-ran the PKG-02 `docker run` command with
the same hardening flags added (`--read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m
--cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m`) — a real
`POST /mcp` `initialize` request against it returned `HTTP/1.1 200 OK` with a normal MCP
result, identical in shape to the unhardened PKG-02 run. The same image/XDG setup that makes
`--read-only` safe for stdio works identically for HTTP. Logged here as a documentation
observation, not routed as a defect, since it doesn't change any criterion's observable
outcome — but the README could adopt the same hardening flags for its HTTP example too.

## 3. Regressions

**None found.**

- `git status --porcelain -uall` (excluding `node_modules`) shows only new/untracked paths
  under `gateway/Dockerfile`, `gateway/.dockerignore`, `gateway/README.md`, and this slice's
  own `docs/spec-loop-runs/mcp-gateway-packaging/` run folder (the specification and
  implementation handoffs, plus this verification handoff and its `verification.report.yaml`
  — both written by this gate). `git diff --stat` against every tracked file is empty.
- Explicitly confirmed empty diff/status for the regression-sensitive paths named in the
  task: `Dockerfile`, `install.sh`, `dd-mcp-proxy.sh`, `.dockerignore` (repo root),
  `mcp-datadog.example.json`, `gateway/src`, `gateway/test` — all untouched.
- Re-ran the full pre-existing suite (`cd gateway && npm test`): **26/26 pass, 0 fail** —
  independently executed in this session, not copied from the implementation handoff.

## 4. Classified failures

**None.** No defect was found in code, spec, or verification model for this slice. The
self-caught defect logged in the implementation handoff (decision #7, writable XDG dirs
under `--read-only`) was independently reproduced as *fixed* in the final `gateway/Dockerfile`
(§1 above) — including proving the regression it fixes is real by building a stripped variant
that fails the same probe. This is not a new defect to route; it is confirmation that a
previously-caught one was actually resolved before hand-off, per the Verification-failure
classification table's silence being appropriate when there is nothing left to classify.

## 5. Overall verdict

**PASS.**

Both gate-1 criteria (PKG-01, PKG-02) have a PASS backed by evidence reproduced
independently in this session: a genuine `docker build --no-cache` from scratch (not reusing
the implementation session's build cache), real MCP exchanges over both stdio and HTTP
against the resulting image using the repo's own mock-backend test fixture (the same,
disclosed substitution the implementation used, since no real Datadog credentials exist
here — this does not prove live-Datadog integration, only the packaged gateway's own
behaviour end-to-end), both happy and failure paths for each transport, and a byte-for-byte
digest match proving "same image, only secret injection/transport env differ" rather than
assuming it. The self-caught XDG/`--read-only` defect was independently verified as fixed,
including proof that the fix is load-bearing. No regression was found outside the five
new/untracked packaging files; `gateway/src`, `gateway/test`, and the root-level
`Dockerfile`/`install.sh`/`dd-mcp-proxy.sh`/`.dockerignore`/`mcp-datadog.example.json` are
all confirmed byte-for-byte untouched, and the pre-existing 26-test suite remains green.
