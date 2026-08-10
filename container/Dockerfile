# syntax=docker/dockerfile:1
# peak-task: shared per-task image. Installs the Peak bundle and the four
# agent CLIs (latest releases, unpinned). Credentials are NEVER baked in:
# API keys come from explicit per-worker env in the mounted Board config,
# and login state via read-only mounts at docker run (AUTH.md).
FROM node:22-slim

WORKDIR /opt/peak
COPY peak/ /opt/peak/
# Externals (commander, tar) are installed at image build; the workers smoke
# check doubles as the node:sqlite availability probe (Node >= 22.19).
RUN npm install --omit=dev --no-audit --no-fund \
 && node cli.js workers > /dev/null \
 && chmod +x cli.js \
 && ln -s /opt/peak/cli.js /usr/local/bin/peak

RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai @earendil-works/pi-coding-agent

# Common task tooling (Cairn-style): adb (+USB access via compose, see
# docker-compose.yaml), frida, radare2, and tmux for long-running interactive
# sessions. libradare2-dev + the build toolchain stay in the image so the
# r2 plugin layers below compile against the exact distro radare2.
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    adb tmux python3 python3-pip git curl ca-certificates patch \
    radare2 libradare2-dev pkg-config make g++ meson ninja-build \
 && pip3 install --break-system-packages --no-cache-dir frida-tools \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# r2ghidra via r2pm (compiles ghidra-native — slow, kept as its own cache
# layer so Peak bundle changes above never invalidate it).
RUN r2pm -U && r2pm -ci r2ghidra

# r2flutter: self-contained C plugin (no Dart SDK needed), built per the
# upstream README and installed into the root user's r2 plugin dir.
RUN git clone --depth 1 https://github.com/radareorg/r2flutter.git /tmp/r2flutter \
 && make -C /tmp/r2flutter \
 && make -C /tmp/r2flutter user-install \
 && rm -rf /tmp/r2flutter

# Skills come from read-only host-global mounts. Missing Board-local Skills are
# mounted individually, also read-only; the container never mutates a Skill
# discovery directory.

COPY entrypoint.sh /usr/local/bin/peak-entrypoint
RUN chmod +x /usr/local/bin/peak-entrypoint
ENTRYPOINT ["/usr/local/bin/peak-entrypoint"]
CMD ["--help"]
