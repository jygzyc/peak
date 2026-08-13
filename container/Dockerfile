# syntax=docker/dockerfile:1
# peak-task: self-contained worker container (Cairn form). The Peak Runtime
# runs on the host and `docker exec`s worker commands in here, so this image
# only carries the agent CLIs, the Android + web toolchain, and Peak's analysis
# helpers — no Peak bundle, no entrypoint, no host mounts. Kali is the base
# because its archive carries the full pentest/reversing toolset (nmap, nuclei,
# ffuf, sqlmap, impacket, proxychains, radare2, jadx, apktool, ...) as plain
# apt packages, so no Go toolchain or prebuilt-binary fetching is needed.
#
# China-mirror build (all upstream by default):
#   podman build container/ -t peak-task:$(cat version) \
#     --build-arg KALI_IMAGE=docker.m.daocloud.io/kalilinux/kali-last-release \
#     --build-arg APT_MIRROR=https://mirrors.ustc.edu.cn/kali \
#     --build-arg NODE_MIRROR=https://registry.npmmirror.com/-/binary/node \
#     --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
#     --build-arg PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/ \
#     --build-arg GH_PROXY=https://gh-proxy.com/
#
# Personal-image seeds (optional but recommended for offline reuse): place
# decx-server.jar (from `decx self install` on a networked host) and APK
# targets under container/seed/. A clean release checkout has no seeds, so the
# optional files are copied from a read-only BuildKit context mount below.
# Credentials are NOT seeded: worker CLIs read the host config dirs mounted
# read-only into the containers at run time.
ARG KALI_IMAGE=docker.io/kalilinux/kali-last-release
ARG APT_MIRROR=
ARG NODE_VERSION=22.19.0
ARG NODE_MIRROR=https://nodejs.org/dist
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PIP_INDEX=https://pypi.org/simple
ARG GH_PROXY=
FROM ${KALI_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Build-time proxy, supplied via --build-arg (host clash on the mirrored WSL
# loopback). Every fetch below (apt/npm/pip/git) honors these; the proxy
# resolves hostnames and decides direct vs proxied per domain, so domestic
# mirrors stay fast and GitHub/npm still work on restricted networks.
ARG HTTP_PROXY
ARG HTTPS_PROXY
ENV http_proxy=${HTTP_PROXY} https_proxy=${HTTPS_PROXY}

# ── Kali toolset: pentest + reversing + system basics + JDK (decx-server) ────
# The kali-last-release base ships without ca-certificates, so bootstrap the
# CA store first (any https mirror fails verification without it), then swap
# to the APT_MIRROR and install the toolset. Build essentials
# (cmake/gcc/pkg-config) stay in so r2ghidra/r2flutter compile against the
# distro radare2 below.
ARG APT_MIRROR
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && apt-get clean && rm -rf /var/lib/apt/lists/*
RUN if [ -n "$APT_MIRROR" ]; then \
      for f in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do \
        [ -f "$f" ] && sed -i "s|https\?://http.kali.org/kali|$APT_MIRROR|g; s|https\?://kali.download/kali|$APT_MIRROR|g" "$f"; \
      done; \
    fi \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    adb tmux python3 python3-pip python3-venv git curl wget unzip ca-certificates xz-utils \
    file binutils socat cmake gcc g++ pkg-config make patch \
    nmap nuclei ffuf sqlmap proxychains4 impacket-scripts chisel \
    radare2 libradare2-dev \
    jadx apktool \
    openjdk-21-jdk-headless \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 (agent CLIs + decx need >= 22.19 for node:sqlite; Kali's is older) ─
ARG NODE_VERSION NODE_MIRROR
RUN ARCH="$(dpkg --print-architecture | sed 's/amd64/x64/')" \
 && curl -fSL --retry 5 --retry-delay 2 --retry-all-errors \
      "${NODE_MIRROR}/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}.tar.xz" \
      -o /tmp/node.tar.xz \
 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
 && rm -f /tmp/node.tar.xz

ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64
ENV PATH="${JAVA_HOME}/bin:${PATH}"

# GitHub via an optional proxy: applies to r2pm's package database and any
# remaining git clone below (decx-server.jar itself is seeded, see below).
ARG GH_PROXY
RUN if [ -n "$GH_PROXY" ]; then \
      git config --global url."${GH_PROXY}https://github.com/".insteadOf "https://github.com/"; \
    fi

# ── Agent CLIs (latest releases, unpinned) ───────────────────────────────────
ARG NPM_REGISTRY
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai @earendil-works/pi-coding-agent @jygzyc/decx-cli

# ── Python analysis tooling: frida (dynamic), androguard (APK), unicorn/capstone (unpack) ─
ARG PIP_INDEX
RUN pip3 install --break-system-packages --no-cache-dir -i "$PIP_INDEX" frida-tools frida androguard unicorn capstone

# ── r2ghidra (native decompiler) + r2flutter via r2pm ────────────────────────
# r2ghidra's C plugin tracks radare2's git master and frequently fails to
# compile against the distro radare2 API; the sleigh-based decompiler installs
# fine from the same package. Keep both best-effort: the image must build
# even when the C plugin does not (decx/jadx is the primary decompiler).
RUN r2pm -U \
 && (r2pm -ci r2ghidra || echo "[peak] r2ghidra C plugin skipped (distro radare2 API mismatch); sleigh decompiler remains available")
RUN (git clone --depth 1 https://github.com/radareorg/r2flutter.git /tmp/r2flutter \
  && make -C /tmp/r2flutter \
  && make -C /tmp/r2flutter user-install \
  && rm -rf /tmp/r2flutter) \
 || echo "[peak] r2flutter skipped"

# ── Personal-image seeds (optional): pre-fetched tooling only ─────────────
# decx-server.jar skips the GitHub release download (`decx self install`) that
# is unreliable on restricted networks. APK targets let containerized workers
# open them without a host mount. Neither path exists in a clean release
# checkout; copy only locally supplied, non-empty seed files.
RUN --mount=type=bind,target=/tmp/peak-build-context \
    mkdir -p /root/.decx/bin /opt/peak/targets \
 && if [ -s /tmp/peak-build-context/seed/decx-server.jar ]; then \
      cp /tmp/peak-build-context/seed/decx-server.jar /root/.decx/bin/decx-server.jar; \
    fi \
 && if [ -d /tmp/peak-build-context/seed/targets ]; then \
      cp -a /tmp/peak-build-context/seed/targets/. /opt/peak/targets/; \
    fi
# NOTE: agent-CLI credentials/config are intentionally NOT baked in. The
# Runtime mounts the host's per-CLI config paths read-only into every task
# container at run time (pi ~/.pi/agent, opencode ~/.config/opencode +
# ~/.local/share/opencode/auth.json, claude-code ~/.claude, codex ~/.codex).

# ── Peak analysis helpers ────────────────────────────────────────────────────
# adb-setup manages the host-adb-server connection from inside the container;
# frida-auto selects a hook bundle. Both are plain shell, reused by every task.
COPY scripts/bin/*.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/*.sh

# Frida hook templates consumed by frida-auto.sh (crypto / ssl-pinning / root).
COPY scripts/frida-hooks/ /opt/peak/frida-hooks/

# Device-bridge reachability. The adb server itself runs on the host
# (`container/device-bridge.sh usb start`); containers reuse it via the gateway.
ENV HOST_GATEWAY=host.docker.internal
ENV ADB_SERVER_SOCKET=tcp:host.docker.internal:5037
ENV FRIDA_SERVER_PORT=14725
ENV PEAK_FRIDA_HOOKS=/opt/peak/frida-hooks

# The Runtime `docker exec`s into this container with `--entrypoint sleep`; this
# CMD only keeps a manually-started container alive between execs.
CMD ["sleep", "infinity"]
