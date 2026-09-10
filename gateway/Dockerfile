# syntax=docker/dockerfile:1.7

###############################################################################
# datadog-mcp-gateway — hardened container image
#
# Packages the gateway's own Node.js app together with the same pinned-
# SHA256 `datadog_mcp_cli` binary the repo-root Dockerfile embeds (fetched
# directly and verified against a pinned SHA-256 — never `curl | bash`).
#
# The gateway connects to `datadog_mcp_cli` as an MCP *child process* over
# stdio (gateway/src/gateway.js `connectBackend`), not as a nested
# container, so the binary must live inside this same image rather than
# being invoked via docker-in-docker. See
# docs/spec-loop-runs/mcp-gateway-packaging/specification.handoff.md
# (Gate 2, unknown #1) for why that option was rejected.
#
# One image serves both deployment shapes in G3/C4: MCP_TRANSPORT selects
# stdio (default, local/Docker) or http (standalone) at *runtime*, so no
# separate image or Dockerfile branch exists for either case.
###############################################################################

# Base images pinned by digest, mirroring the repo-root Dockerfile's
# convention. Re-pin deliberately when you want newer bases.
ARG BASE_IMAGE=debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:53ada149d435c38b14476cb57e4a7da73c15595aba79bd6971b547ceb6d018bf

# Upstream download location and the SHA-256 of each architecture's binary.
# Kept identical to the repo-root Dockerfile's values — update both
# Dockerfiles together whenever you bump the CLI version.
ARG DOWNLOAD_BASE_URL=https://coterm.datadoghq.com/mcp-cli
ARG SHA256_AMD64=d9a30c41f397e7f579ccbdeec7a6faf144f584918b06d463639e62a953a559c0
ARG SHA256_ARM64=5fb3f5c8c7e7259d29a0d925bfd0245f778680a0bc2f92fb1cd99b50a8e5d588

###############################################################################
# Stage 1: downloader — fetch + verify datadog_mcp_cli. Identical pattern to
# the repo-root Dockerfile's stage 1: a pinned-SHA256 mismatch aborts the
# build via `sha256sum --check --strict`, and an unsupported TARGETARCH
# exits non-zero with a message. None of these tools reach the runtime.
###############################################################################
FROM ${BASE_IMAGE} AS downloader

ARG DOWNLOAD_BASE_URL
ARG SHA256_AMD64
ARG SHA256_ARM64
# TARGETARCH is provided automatically by BuildKit (amd64 / arm64).
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    case "${TARGETARCH}" in \
        amd64) suffix="linux-amd64"; sha="${SHA256_AMD64}" ;; \
        arm64) suffix="linux-arm64"; sha="${SHA256_ARM64}" ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    url="${DOWNLOAD_BASE_URL}/datadog_mcp_cli-${suffix}"; \
    echo "Downloading ${url}"; \
    curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
         -o /tmp/datadog_mcp_cli "${url}"; \
    echo "${sha}  /tmp/datadog_mcp_cli" | sha256sum --check --strict -; \
    chmod 0755 /tmp/datadog_mcp_cli; \
    test "$(head -c 4 /tmp/datadog_mcp_cli | od -An -tx1 | tr -d ' \n')" = "7f454c46"

###############################################################################
# Stage 2: node-deps — install production npm dependencies only, from the
# committed lockfile (`npm ci`), isolated from the app source so source-only
# changes don't invalidate this layer.
###############################################################################
FROM ${NODE_IMAGE} AS node-deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

###############################################################################
# Stage 3: runtime — minimal, non-root, no build tooling.
###############################################################################
FROM ${NODE_IMAGE} AS runtime

# Only the CA bundle is needed at runtime (datadog_mcp_cli talks TLS to
# Datadog; the gateway itself talks plain HTTP unless fronted by a
# TLS-terminating host). Drop setuid/setgid bits, same as the root image.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true

# Verified binary; owned by root, world-executable, never writable by the
# runtime user — same defense-in-depth as the root Dockerfile.
COPY --from=downloader --chown=root:root --chmod=0755 \
     /tmp/datadog_mcp_cli /usr/local/bin/datadog_mcp_cli

WORKDIR /app
COPY --from=node-deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# node:*-bookworm-slim already ships an unprivileged `node` user
# (uid/gid 1000, home /home/node) — reuse it instead of creating another.
#
# datadog_mcp_cli writes its config/credentials (from `login`, or cached
# state) under XDG dirs in $HOME, same as the root Dockerfile. Point those
# at /home/node explicitly and keep it writable so a caller running this
# image with `--read-only` (as the stdio docs recommend, mirroring
# dd-mcp-proxy.sh) still gives the backend child process somewhere to
# write — without this, `--read-only` would break the backend the first
# time it tries to persist anything.
ENV HOME=/home/node \
    XDG_CONFIG_HOME=/home/node/.config \
    XDG_DATA_HOME=/home/node/.local/share \
    XDG_CACHE_HOME=/home/node/.cache \
    NODE_ENV=production \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

RUN install -d -o node -g node -m 0700 \
    /home/node/.config /home/node/.local/share /home/node/.cache

USER node
WORKDIR /app
VOLUME ["/home/node"]

# Documents the HTTP transport's listen port; has no effect on the stdio
# transport and does not itself publish anything (that's -p/--publish at
# `docker run` time).
EXPOSE 8080

LABEL org.opencontainers.image.title="datadog-mcp-gateway" \
      org.opencontainers.image.description="Shared-secret MCP gateway proxying a subset of Datadog MCP tools (stdio or HTTP transport, selected by MCP_TRANSPORT)" \
      org.opencontainers.image.source="https://coterm.datadoghq.com/mcp-cli"

ENTRYPOINT ["node", "src/index.js"]
