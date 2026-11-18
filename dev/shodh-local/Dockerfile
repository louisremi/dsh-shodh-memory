# Local shodh-memory server for developing @louisremi/dsh-shodh-memory.
#
# Why not the upstream image: varunshodh/shodh-memory:0.2.0 is published for
# linux/amd64 only. This builds from the official GitHub release tarball for
# whichever architecture the daemon builds on (arm64 and amd64), verified against
# the sha256 digests pinned below. Those digests come from the release API:
#   curl -s https://api.github.com/repos/varun29ankuS/shodh-memory/releases/tags/v<ver> \
#     | jq -r '.assets[] | "\(.name) \(.digest)"'
#
# glibc: upstream's x64 build needs glibc 2.39 and its arm64 build needs 2.34.
# Debian 13 (trixie) ships 2.41.
FROM debian:trixie-slim

ARG SHODH_VERSION=0.2.0
ARG SHA256_ARM64=8db8765efdb5fb5ac4b9ef4fc014eac329dcfc343bd426fd6c0f7553893e7665
ARG SHA256_X64=abf2e255355c46ef9333342cc4b58234e032bfe8c4cbbdef81c814cdf58182ed
ARG TARGETARCH

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl libstdc++6; \
    rm -rf /var/lib/apt/lists/*; \
    case "$TARGETARCH" in \
      arm64) asset=linux-arm64; sum="$SHA256_ARM64" ;; \
      amd64) asset=linux-x64; sum="$SHA256_X64" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/shodh.tgz \
      "https://github.com/varun29ankuS/shodh-memory/releases/download/v${SHODH_VERSION}/shodh-memory-${asset}.tar.gz"; \
    echo "$sum  /tmp/shodh.tgz" | sha256sum -c -; \
    mkdir -p /opt/shodh; \
    tar -xzf /tmp/shodh.tgz -C /opt/shodh; \
    rm /tmp/shodh.tgz; \
    useradd --uid 1000 --create-home --shell /usr/sbin/nologin shodh; \
    mkdir -p /data; chown shodh:shodh /data

ENV LD_LIBRARY_PATH=/opt/shodh \
    SHODH_HOST=0.0.0.0 \
    SHODH_PORT=3030 \
    SHODH_MEMORY_PATH=/data \
    SHODH_ZENOH_ENABLED=false

USER shodh
WORKDIR /home/shodh
VOLUME /data
EXPOSE 3030

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD curl -fsS -o /dev/null http://127.0.0.1:3030/health || exit 1

ENTRYPOINT ["/opt/shodh/shodh-memory-server"]
