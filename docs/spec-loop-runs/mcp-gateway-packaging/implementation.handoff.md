# Implementation handoff: `mcp-gateway-packaging`

Consumed input: `docs/spec-loop-runs/mcp-gateway-packaging/specification.handoff.md`
(PKG-01/PKG-02 acceptance criteria) only.

## 1. Implementation plan

1. `gateway/Dockerfile` — multi-stage build, following the repo-root
   `Dockerfile`'s pinned-SHA256 download-and-verify pattern for
   `datadog_mcp_cli` (resolving Gate-2 unknown #1: embed the binary
   directly, no docker-in-docker), plus two Node.js-specific stages
   (`node-deps` for `npm ci --omit=dev`, `runtime` for the final minimal
   non-root image). One `ENTRYPOINT ["node", "src/index.js"]`; transport
   selection (`MCP_TRANSPORT`) stays entirely a runtime env var, so the same
   image serves both PKG-01 (stdio) and PKG-02 (http) with zero branching.
2. `gateway/.dockerignore` — restrict the build context to
   `package.json`/`package-lock.json`/`src` (the app), mirroring the intent
   of the root `.dockerignore` (minimal context) but not its literal
   "block everything" form, since this build does need local app source
   (unlike the root image, which fetches everything remotely).
3. `gateway/README.md` — build command, local stdio run (with hardening
   flags mirrored from `dd-mcp-proxy.sh`, and an example MCP client config
   mirroring `mcp-datadog.example.json`'s shape), standalone HTTP run (env
   vars only, no named cloud platform per §3.2), failure behaviour for both
   transports, and a configuration-variable reference table.
4. Build the image and run real MCP exchanges against it (both transports,
   happy path and failure path) as evidence — see §4.

No changes were made to `gateway/src/*` or `gateway/test/*` — this slice is
packaging-only; AC1–AC6 (`mcp-gateway-core`/`mcp-gateway-http`) were already
done and are not touched.

## 2. Changed files

| File | Change |
|---|---|
| `gateway/Dockerfile` | New. Multi-stage build: `downloader` (pinned-SHA256 `datadog_mcp_cli` fetch, identical pattern to root `Dockerfile`) → `node-deps` (`npm ci --omit=dev`) → `runtime` (non-root, `node` user already in the `node:*-bookworm-slim` base, CA bundle, verified binary + app). |
| `gateway/.dockerignore` | New. Build context limited to `package.json`, `package-lock.json`, `src/`. |
| `gateway/README.md` | New. Build/run docs for stdio and standalone-HTTP deployment, configuration reference, failure behaviour for both transports. |

No other files were modified.

## 3. Decision log

| # | Decision | Classification | Rationale |
|---|---|---|---|
| 1 | Embed `datadog_mcp_cli` directly in `gateway/Dockerfile` rather than shelling out to the root image via `docker run` | Class 2 (carried forward from specification handoff Gate 2, unknown #1) | Already settled by the spec handoff; implemented as directed — pinned-SHA256 download-and-verify stage, byte-identical `ARG` names/defaults/URLs to the root `Dockerfile` so both Dockerfiles are updated together when the CLI version bumps. |
| 2 | Pin the Node base image (`node:22-bookworm-slim`) by digest, same convention as the root `Dockerfile`'s `BASE_IMAGE` | Class 3 | The root `Dockerfile`'s header comment states the rationale ("pinned by digest... re-pin deliberately when you want a newer base") and this is an internal build-reproducibility choice with no observable-behaviour impact on PKG-01/PKG-02 — a two-way door. Digest resolved from the locally cached `node:22-bookworm-slim` tag (`docker inspect --format '{{.Id}}'`), which happened to already be cached in this environment. |
| 3 | Split npm dependency install into its own `node-deps` stage rather than installing in the `runtime` stage directly | Class 3 | Standard Docker layering practice (source-only changes don't invalidate the `npm ci` layer); reversible, no observable-behaviour impact on the criteria. |
| 4 | Reuse the `node` user (uid/gid 1000) that `node:*-bookworm-slim` already ships, instead of creating a new user the way the root `Dockerfile` does for its `app` user | Class 2 | Investigated directly: `docker run --rm node:22-bookworm-slim id node` confirms uid=1000(node) gid=1000(node) already exists with `/home/node`. Creating a second, redundant user would contradict "minimal, no build tooling" with no benefit — an existing convention (the base image itself) already answers this. |
| 5 | Prove PKG-01/PKG-02's real MCP exchange using the repo's own test-fixture mock backend (`gateway/test/fixtures/mock-datadog-server.js`, via `BACKEND_COMMAND`/`BACKEND_ARGS`) rather than the real Datadog API | Class 2 | This sandbox has no real `DD_API_KEY`/`DD_APP_KEY` credentials, and none were supplied for this task — obtaining them is outside this repo/slice's control. `gateway/test/stdio-auth.test.js` already establishes `BACKEND_COMMAND`/`BACKEND_ARGS` override as this repo's own convention for substituting a stand-in backend in tests without weakening what's being proven: the criteria under test (PKG-01/PKG-02) are about the *gateway's* packaged stdio/HTTP MCP behaviour end-to-end inside the container, not about Datadog's own API — the mock backend is a real MCP server, spawned as a real child process inside the real built container, so the full gateway code path (auth gate → backend connect → transport → tool forwarding) is exercised exactly as it would be with the real binary. The real `datadog_mcp_cli` binary is still embedded, verified, and on `PATH` in the image (confirmed via the `downloader`/`sha256sum` build log in §4) — only the *test's* choice of backend command differs, which is the intended purpose of `BACKEND_COMMAND`. This is recorded here, not silently assumed, per the evidence-bundle honesty requirement. |
| 6 | `.dockerignore` uses an allowlist (`*` then `!package.json` etc.) rather than the root's bare `*`/`!Dockerfile` | Class 2 | The root `Dockerfile` needs zero local context (everything is fetched remotely), so `!Dockerfile` alone works. This Dockerfile's `node-deps`/`runtime` stages `COPY` local `package.json`/`package-lock.json`/`src` — omitting them from the context would break the build. The allowlist form is the direct, investigated consequence of what `COPY` instructions this Dockerfile actually has. |
| 7 | Set `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_CACHE_HOME` under `/home/node` and declare `VOLUME ["/home/node"]` in the runtime stage | Class 2 (self-correction; caught by review before hand-off) | The root `Dockerfile` does exactly this for the same reason: `datadog_mcp_cli` persists config/credentials/cache under XDG dirs in `$HOME`, and the README's documented stdio run command uses `--read-only` (mirroring `dd-mcp-proxy.sh`). Without a writable, XDG-pointed home, `--read-only` would break the backend the first time it tries to persist state — a real defect, not a hypothetical one, since it's the *documented* command. First build/verification pass omitted this; caught during review, fixed, and the full PKG-01/PKG-02 evidence bundle in §4 was re-run against the corrected image (new digest) before this handoff was finalized. |

## 4. Evidence bundle

Environment: Docker Engine 28.0.0 (community), BuildKit, confirmed available
via `docker --version` / `docker info` before starting (no docker-availability
constraint hit in this environment). All commands below were run for real,
raw output captured; nothing here is inferred or asserted without a
corresponding artifact.

Image built once, reused for every PKG-01 and PKG-02 check below. (An
earlier build, digest `sha256:2212...2037e`, was superseded after the
review in decision #7 above added the writable-XDG-home fix; every check
below was reproduced against the corrected image, not the earlier one.)

```
$ docker build -t datadog-mcp-gateway:latest -f gateway/Dockerfile gateway
...
#22 exporting to image
#22 writing image sha256:78be4beed6d633d74e5cf7a7cad3f54ca5bc7661f5ee69e3a6d2a47b591ad3f8 done
#22 naming to docker.io/library/datadog-mcp-gateway:latest done
```

Image digest used throughout: **`sha256:78be4beed6d633d74e5cf7a7cad3f54ca5bc7661f5ee69e3a6d2a47b591ad3f8`**.

All PKG-01 stdio invocations below use the **exact flag set the README
documents**, including `--read-only` (mirroring `dd-mcp-proxy.sh`'s
hardening) — not a stripped-down `docker run`, per PKG-01's verification
method's explicit requirement to reproduce the documented command
verbatim.

| Requirement | Evidence | Result |
|---|---|---|
| **PKG-01 happy path** — `docker build` exits 0; documented stdio run (verbatim, including `--read-only`/tmpfs/cap-drop/etc.) + a real `initialize`/`tools/call` returns a valid, non-error MCP response. | `command`: full build log ending `naming to docker.io/library/datadog-mcp-gateway:latest 0.0s done`, build process exit code confirmed `0`. `command`: driver script using `@modelcontextprotocol/sdk`'s real `Client`/`StdioClientTransport` spawning `docker run --rm -i -e GATEWAY_API_KEY=expected-secret -e GATEWAY_CLIENT_KEY=expected-secret -e BACKEND_COMMAND=node -e BACKEND_ARGS=/app/mock-backend.js -v <fixture>:/app/mock-backend.js:ro --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m datadog-mcp-gateway:latest` — i.e. the README's documented flags verbatim, plus only the `-e`/`-v` overrides needed to substitute the mock backend (decision #5) — performing a real MCP `initialize` handshake, `tools/list`, and `tools/call`. Raw stdout: `SERVER_INFO: {"name":"datadog-mcp-gateway","version":"0.1.0"}` / `TOOLS_LIST: ["search_logs","get_metric","delete_monitor","always_fails"]` / `TOOLS_CALL_RESULT: {"content":[{"type":"text","text":"called:search_logs"}]}`. Raw stderr shows the handshake succeeding under `--read-only` and the gateway's own stderr-only call log line: `{"ts":"2026-07-24T16:37:46.475Z","tool":"search_logs","outcome":"success","durationMs":4}` — proving the writable-XDG-home fix (decision #7) actually works under the exact hardening flags the docs recommend, not just without them. | **PASS** |
| **PKG-01 failure path** — missing `GATEWAY_API_KEY` ⇒ non-zero exit, error on stderr only, stdout empty, no MCP response within a bounded timeout. | `command`: `docker run --rm -i --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m --cap-drop=ALL --security-opt=no-new-privileges --pids-limit=128 --memory=256m datadog-mcp-gateway:latest < /dev/null` (same hardened, documented flags). Exit code `1`. stdout captured to file: 0 bytes. stderr: `Error: GATEWAY_API_KEY is required (the shared secret clients must present)` with a full stack trace, nothing else. Separately, `command`: real MCP `Client.connect()` (same SDK, `StdioClientTransport` spawning `docker run --rm -i datadog-mcp-gateway:latest`, unhardened variant, re-run against the corrected `78be…` digest) with a 5000ms bound — rejected in ~1.05s wall-clock (`time` measured) with `EXPECTED_REJECTION: MCP error -32000: Connection closed`, i.e. the handshake never completed, well inside the bound. | **PASS** |
| **PKG-02 happy path** — the *same image digest* run standalone with `MCP_TRANSPORT=http`, `PORT` set, secrets injected only via env vars (no named cloud platform); a real `POST /mcp` succeeds with a response structurally equal to the backend's own response. | `command`: `docker inspect --format '{{.Id}}' datadog-mcp-gateway:latest` → `sha256:78be...ad3f8` (same digest as the PKG-01 build, no rebuild). `command`: `docker run -d --rm -e GATEWAY_API_KEY=standalone-secret -e MCP_TRANSPORT=http -e PORT=8080 -e BACKEND_COMMAND=node -e BACKEND_ARGS=/app/mock-backend.js -v <fixture>:/app/mock-backend.js:ro -p <host>:8080 <digest>`; `docker inspect --format '{{.Image}}' <container id>` → identical digest, confirming "same image, only secret injection/transport env differ." `api_response`: SDK `StreamableHTTPClientTransport` real `initialize` + `tools/list` + `tools/call` over `http://localhost:<port>/mcp` with `Authorization: Bearer standalone-secret` → `SERVER_INFO: {"name":"datadog-mcp-gateway","version":"0.1.0"}` / `TOOLS_LIST: [...]` / `TOOLS_CALL_RESULT: {"content":[{"type":"text","text":"called:search_logs"}]}` — structurally identical shape to the mock backend's own response (`{"content":[{"type":"text","text":"called:search_logs"}]}`), matching the HTTP-AC1 bar. | **PASS** |
| **PKG-02 failure paths** — bad/missing `Authorization: Bearer` ⇒ `HTTP 401` before backend contact, isolated per-request; missing `GATEWAY_API_KEY` at HTTP startup ⇒ same fail-fast-to-stderr/non-zero-exit as PKG-01. | `command`: `curl -i -X POST http://localhost:<port>/mcp` with `Authorization: Bearer wrong-secret` → raw response `HTTP/1.1 401 Unauthorized` / `{"error":"unauthorized"}`. Repeated with the header omitted entirely → same `401`/`{"error":"unauthorized"}`. `command`: `docker run --rm -e MCP_TRANSPORT=http -e PORT=8080 datadog-mcp-gateway:latest` (no `GATEWAY_API_KEY`) → exit code `1`, stdout 0 bytes, stderr `Error: GATEWAY_API_KEY is required (the shared secret clients must present)` — identical error/behaviour shape to the PKG-01 stdio failure path. | **PASS** |

### Note on the mock-backend substitution (honesty disclosure)

No real `DD_API_KEY`/`DD_APP_KEY` were available in this environment. Per
decision-log #5, PKG-01/PKG-02's real-MCP-exchange evidence above uses the
repo's own `test/fixtures/mock-datadog-server.js` as the backend (via
`BACKEND_COMMAND=node BACKEND_ARGS=/app/mock-backend.js`, bind-mounted into
the running container), which is a real, separate MCP stdio server process —
not a fake response injected into the gateway itself. This proves every
part of PKG-01/PKG-02's stated observable outcome that is under this
package's control: the container starts, the auth gate runs, a real child
process is spawned and MCP-connects, tool listing/allowlisting/forwarding
works, and the external MCP exchange (stdio or HTTP) round-trips a real
response. It does **not** prove that the specific *real* `datadog_mcp_cli`
binary embedded in the image successfully authenticates to Datadog's live
API with real credentials — that was already out of scope for AC1–AC6 and
is unaffected by this packaging slice; the binary's presence, SHA-256
verification, and executability were separately confirmed during the build
(`downloader` stage's `sha256sum --check --strict` + ELF-magic-byte check,
both passed — see the build log).

## 5. Note on scope

Per `docs/SPEC_LOOP.md`'s separated-role workflow, emitting
`verification.report.yaml` is gate 5 (Verify)'s responsibility, not this
Implementation-agent handoff's. The evidence bundle in §4 above — raw,
reproducible command output and API responses, both happy and failure paths
for PKG-01 and PKG-02 — is what a verifier reproduces its `pass`/`fail`
judgement from.
