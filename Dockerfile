# syntax=docker/dockerfile:1.7

###############################################################################
# datadog_mcp_cli — hardened container image
#
# The upstream installer (https://coterm.datadoghq.com/mcp-cli/install.sh) just
# detects OS/arch and downloads a prebuilt, statically-linked binary. We do NOT
# run that script at build time (no `curl | bash`). Instead we fetch the binary
# directly and verify it against a pinned SHA-256 so the build is reproducible
# and tamper-evident.
#
# The binary is a static Rust executable using rustls + rustls-native-certs,
# so the only runtime dependency is the system CA bundle (ca-certificates).
###############################################################################

# Base image pinned by digest (debian:bookworm-slim multi-arch index,
# built 2026-06-23). Re-pin deliberately when you want a newer base.
ARG BASE_IMAGE=debian:bookworm-slim@sha256:60eac759739651111db372c07be67863818726f754804b8707c90979bda511df

# Upstream download location and the SHA-256 of each architecture's binary.
# Update these together whenever you bump the CLI version.
ARG DOWNLOAD_BASE_URL=https://coterm.datadoghq.com/mcp-cli
ARG SHA256_AMD64=d9a30c41f397e7f579ccbdeec7a6faf144f584918b06d463639e62a953a559c0
ARG SHA256_ARM64=5fb3f5c8c7e7259d29a0d925bfd0245f778680a0bc2f92fb1cd99b50a8e5d588

###############################################################################
# Stage 1: downloader — fetch + verify. None of these tools reach the runtime.
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
    # Fail fast if we somehow fetched something that isn't an ELF executable
    # (portable: compare the first 4 magic bytes as hex).
    test "$(head -c 4 /tmp/datadog_mcp_cli | od -An -tx1 | tr -d ' \n')" = "7f454c46"

###############################################################################
# Stage 2: runtime — minimal, non-root, no build tooling.
###############################################################################
FROM ${BASE_IMAGE} AS runtime

# Only the CA bundle is needed at runtime; install nothing else.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    # Drop every setuid/setgid bit in the image to remove privilege-escalation
    # surface (no use case here needs them).
    find / -xdev -type f -perm /6000 -exec chmod a-s {} + 2>/dev/null || true; \
    # Create an unprivileged, no-login user with a fixed high UID/GID.
    groupadd --gid 10001 app; \
    useradd  --uid 10001 --gid 10001 --no-log-init \
             --home-dir /home/app --create-home --shell /usr/sbin/nologin app

# Copy the verified binary; owned by root, world-executable, never writable by
# the runtime user (defense against the binary being swapped at runtime).
COPY --from=downloader --chown=root:root --chmod=0755 \
     /tmp/datadog_mcp_cli /usr/local/bin/datadog_mcp_cli

# Credentials/config (written by `datadog_mcp_cli login`) land under the user's
# home. Point XDG dirs there explicitly and expose it as a volume so a
# read-only root filesystem still has a writable, persistable location.
ENV HOME=/home/app \
    XDG_CONFIG_HOME=/home/app/.config \
    XDG_DATA_HOME=/home/app/.local/share \
    XDG_CACHE_HOME=/home/app/.cache \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

RUN set -eux; \
    install -d -o app -g app -m 0700 \
        /home/app/.config /home/app/.local/share /home/app/.cache

USER app
WORKDIR /home/app
VOLUME ["/home/app"]

# OCI metadata.
LABEL org.opencontainers.image.title="datadog_mcp_cli" \
      org.opencontainers.image.description="Hardened container for the Datadog MCP CLI proxy" \
      org.opencontainers.image.source="https://coterm.datadoghq.com/mcp-cli" \
      org.opencontainers.image.base.name="debian:bookworm-slim"

ENTRYPOINT ["datadog_mcp_cli"]
CMD ["--help"]
