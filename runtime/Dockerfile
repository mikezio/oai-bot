FROM debian:trixie-slim

ARG OAI_RUNTIME_UID=1000
ARG OAI_RUNTIME_GID=1000
ARG OAI_CODEX_VERSION=0.151.0

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash ca-certificates chromium curl dbus-x11 git iproute2 jq \
    nodejs npm novnc picom procps python3 python3-pip tini thunar \
    websockify x11-utils x11vnc xfwm4 xvfb \
  && rm -rf /var/lib/apt/lists/* \
  && dbus-uuidgen --ensure=/etc/machine-id \
  && npm install --global "@openai/codex@${OAI_CODEX_VERSION}" \
  && npm cache clean --force \
  && groupadd --gid "$OAI_RUNTIME_GID" bot \
  && useradd --uid "$OAI_RUNTIME_UID" --gid bot --create-home --shell /bin/bash bot \
  && install -d -o bot -g bot /workspace /home/bot/.local/share /home/bot/.cache /home/bot/sand-data /run/oai-runtime \
  && ln -s /home/bot/sand-data /home/bot/agent-data

COPY runtime/oai-runtime-entrypoint /usr/local/bin/oai-runtime-entrypoint
COPY runtime/oai-runtime-doctor /usr/local/bin/oai-runtime-doctor
COPY runtime/oai-runtime-browser /usr/local/bin/oai-runtime-browser
RUN chmod 0755 /usr/local/bin/oai-runtime-entrypoint /usr/local/bin/oai-runtime-doctor /usr/local/bin/oai-runtime-browser

ENV HOME=/home/bot \
    DISPLAY=:1 \
    XDG_RUNTIME_DIR=/run/oai-runtime \
    XDG_CONFIG_HOME=/home/bot/.local/share/config \
    XDG_CACHE_HOME=/home/bot/.cache \
    BROWSER=/usr/local/bin/oai-runtime-browser \
    OAI_RUNTIME_SCREEN=1280x800x24

WORKDIR /workspace
USER bot

EXPOSE 4096 6080
VOLUME ["/workspace", "/home/bot/.local/share", "/home/bot/sand-data"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/oai-runtime-entrypoint"]
