# ------------------------------------------------------------------------------
# Build execd
# ------------------------------------------------------------------------------
FROM golang:1.24.0 AS execd-builder

WORKDIR /build
COPY execd/go.mod execd/go.sum ./
RUN go mod download
COPY execd/ ./
RUN CGO_ENABLED=0 go build -o /out/execd ./main.go

# ------------------------------------------------------------------------------
# Runtime image
# ------------------------------------------------------------------------------
FROM ubuntu:24.04

ARG TARGETARCH

SHELL ["/bin/bash", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    EXECD_PORT=44772 \
    EXECD_LOG_LEVEL=6 \
    DISPLAY=:99.0 \
    DISPLAY_WIDTH=1280 \
    DISPLAY_HEIGHT=720 \
    DISPLAY_DEPTH=24 \
    VNC_SERVER_PORT=5900 \
    WEBSOCKET_PROXY_PORT=6080 \
    PUBLIC_PORT=8080 \
    GO_VERSION=1.25.5 \
    JAVA_VERSION=21 \
    LOG_DIR=/var/log/kx-sandbox \
    NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules \
    NODE_VERSION=22 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    PYTHON_VERSION=3.12 \
    KX_SANDBOX_IMAGE_VERSION=1.0.6

ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# ------------------------------------------------------------------------------
# APT mirrors
# ------------------------------------------------------------------------------
RUN if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i 's|http://ports.ubuntu.com/ubuntu-ports|http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' /etc/apt/sources.list.d/ubuntu.sources; \
      sed -i 's|https://ports.ubuntu.com/ubuntu-ports|http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' /etc/apt/sources.list.d/ubuntu.sources; \
      sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources; \
      sed -i 's|https://archive.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources; \
      sed -i 's|http://security.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources; \
      sed -i 's|https://security.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|http://ports.ubuntu.com/ubuntu-ports|http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' /etc/apt/sources.list; \
      sed -i 's|https://ports.ubuntu.com/ubuntu-ports|http://mirrors.tuna.tsinghua.edu.cn/ubuntu-ports|g' /etc/apt/sources.list; \
      sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list; \
      sed -i 's|https://archive.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list; \
      sed -i 's|http://security.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list; \
      sed -i 's|https://security.ubuntu.com/ubuntu|http://mirrors.tuna.tsinghua.edu.cn/ubuntu|g' /etc/apt/sources.list; \
    fi

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Restore the mirror URL to HTTPS after CA certificates are available.
RUN if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i -E 's|http://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/ubuntu/?|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && if [ -f /etc/apt/sources.list ]; then \
      sed -i -E 's|http://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/ubuntu/?|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list; \
    fi

# ------------------------------------------------------------------------------
# System dependencies
# ------------------------------------------------------------------------------
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
    curl wget unzip zip tar git build-essential \
    gettext-base \
    libreoffice \
    python3 python3-pip python3-venv \
    openjdk-21-jdk \
    nginx supervisor \
    tigervnc-standalone-server x11-xserver-utils \
    openbox websockify netcat-openbsd \
    fontconfig fonts-noto-cjk fonts-wqy-zenhei \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

RUN python3 -m pip install --break-system-packages \
    pandas \
    openpyxl

# ------------------------------------------------------------------------------
# Node.js and JS tooling
# ------------------------------------------------------------------------------
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install common JS tooling and preload browser binaries for agent-browser.
RUN set -euo pipefail \
    && npm install -g openskills agent-browser docx \
    && npm install -g playwright --ignore-scripts \
    && agent-browser install --with-deps

# ------------------------------------------------------------------------------
# Go toolchain
# ------------------------------------------------------------------------------
RUN case "${TARGETARCH}" in \
      amd64) go_arch="amd64" ;; \
      arm64) go_arch="arm64" ;; \
      "") \
        case "$(uname -m)" in \
          x86_64) go_arch="amd64" ;; \
          aarch64) go_arch="arm64" ;; \
          *) echo "Unsupported arch: $(uname -m)"; exit 1 ;; \
        esac ;; \
      *) echo "Unsupported TARGETARCH: ${TARGETARCH}"; exit 1 ;; \
    esac \
    && curl -fL --retry 6 --retry-all-errors --retry-delay 3 --connect-timeout 20 \
      "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tar.gz \
    && tar -C /usr/local -xzf /tmp/go.tar.gz \
    && rm -f /tmp/go.tar.gz

# ------------------------------------------------------------------------------
# noVNC assets
# ------------------------------------------------------------------------------
ARG NOVNC_VERSION=v1.4.0
RUN curl -fL --retry 6 --retry-all-errors --retry-delay 3 --connect-timeout 20 \
      "https://github.com/novnc/noVNC/archive/refs/tags/${NOVNC_VERSION}.zip" -o /tmp/novnc.zip \
    && unzip -q /tmp/novnc.zip -d /tmp/novnc \
    && mv "/tmp/novnc/noVNC-${NOVNC_VERSION#v}" /opt/novnc \
    && cp /opt/novnc/vnc.html /opt/novnc/index.html \
    && rm -rf /tmp/novnc /tmp/novnc.zip

# ------------------------------------------------------------------------------
# Sandbox bootstrap
# ------------------------------------------------------------------------------
RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && mkdir -p /opt/kx-sandbox /opt/kx-sandbox/conf.d /opt/kuxuan/wechat-worker /data/wechat-worker/profile

COPY wechat-worker/ /opt/kuxuan/wechat-worker/

COPY --from=execd-builder /out/execd /opt/kx-sandbox/execd

RUN cat >/opt/kx-sandbox/start.sh <<'SHEOF'
#!/usr/bin/env bash
set -euo pipefail

log_dir="${LOG_DIR:-/var/log/kx-sandbox}"

mkdir -p /tmp/.X11-unix "${log_dir}" /opt/kx-sandbox/conf.d
chmod 1777 /tmp/.X11-unix "${log_dir}"

mkdir -p /root/.agent/skills /root/.agent/system_skills /root/.agent/user_skills

find /root/.agent/system_skills -mindepth 1 -maxdepth 1 -type d | while read -r d; do
  if [ -f "$d/SKILL.md" ]; then
    name="$(basename "$d")"
    if [ ! -e "/root/.agent/user_skills/${name}" ]; then
      cp -a "$d" "/root/.agent/user_skills/${name}"
    fi
  fi
done

find /root/.agent/user_skills -mindepth 1 -maxdepth 1 -type d | while read -r d; do
  if [ -f "$d/SKILL.md" ]; then
    name="$(basename "$d")"
    ln -sfnT "$d" "/root/.agent/skills/${name}"
  fi
done

envsubst '${PUBLIC_PORT} ${WEBSOCKET_PROXY_PORT} ${EXECD_PORT}' \
  </opt/kx-sandbox/nginx.conf.template \
  >/opt/kx-sandbox/nginx.conf

exec /usr/bin/supervisord -n -c /opt/kx-sandbox/supervisord.conf
SHEOF

RUN cat >/opt/kx-sandbox/execd-wrapper.sh <<'SHEOF'
#!/usr/bin/env bash
set -euo pipefail

execd_args=(
  "--port=${EXECD_PORT:-44772}"
  "--log-level=${EXECD_LOG_LEVEL:-6}"
)
if [ -n "${EXECD_ACCESS_TOKEN:-}" ]; then
  execd_args+=("--access-token=${EXECD_ACCESS_TOKEN}")
fi

exec /opt/kx-sandbox/execd "${execd_args[@]}" "$@"
SHEOF

RUN cat >/opt/kx-sandbox/supervisord.conf <<'SHEOF'
[supervisord]
nodaemon=true
user=root
pidfile=/var/run/supervisord.pid
logfile=/dev/null
logfile_maxbytes=0
loglevel=info

[include]
files=/opt/kx-sandbox/conf.d/*.conf
SHEOF

RUN cat >/opt/kx-sandbox/conf.d/10-vnc.conf <<'SHEOF'
[program:tigervnc]
command=/usr/bin/Xvnc %(ENV_DISPLAY)s -depth %(ENV_DISPLAY_DEPTH)s -geometry %(ENV_DISPLAY_WIDTH)sx%(ENV_DISPLAY_HEIGHT)s -localhost -rfbport %(ENV_VNC_SERVER_PORT)s -AlwaysShared -SecurityTypes None
autorestart=true
priority=900
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0

[program:websockify]
command=/usr/bin/websockify --web /opt/novnc %(ENV_WEBSOCKET_PROXY_PORT)s localhost:%(ENV_VNC_SERVER_PORT)s
autorestart=true
priority=890
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SHEOF

RUN cat >/opt/kx-sandbox/conf.d/20-openbox.conf <<'SHEOF'
[program:openbox]
environment=DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox
autorestart=true
priority=880
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SHEOF

RUN cat >/opt/kx-sandbox/conf.d/30-nginx.conf <<'SHEOF'
[program:nginx]
command=/usr/sbin/nginx -c /opt/kx-sandbox/nginx.conf -g "daemon off;"
autorestart=true
priority=870
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SHEOF

RUN cat >/opt/kx-sandbox/conf.d/40-execd.conf <<'SHEOF'
[program:execd]
command=/opt/kx-sandbox/execd-wrapper.sh
autorestart=true
priority=800
stdout_logfile=/dev/stdout
stdout_logfile_maxbytes=0
stderr_logfile=/dev/stderr
stderr_logfile_maxbytes=0
SHEOF

RUN cat >/opt/kx-sandbox/nginx.conf.template <<'SHEOF'
worker_processes 1;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }

    server {
        listen ${PUBLIC_PORT};
        listen [::]:${PUBLIC_PORT};

        location /vnc/ {
            alias /opt/novnc/;
            index index.html vnc.html;
        }

        location /websockify {
            proxy_pass http://127.0.0.1:${WEBSOCKET_PROXY_PORT}/;
            proxy_set_header Host $host;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /vnc/websockify {
            proxy_pass http://127.0.0.1:${WEBSOCKET_PROXY_PORT}/;
            proxy_set_header Host $host;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location /ws {
            proxy_pass http://127.0.0.1:${WEBSOCKET_PROXY_PORT}/;
            proxy_set_header Host $host;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }

        location / {
            proxy_pass http://127.0.0.1:${EXECD_PORT}/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
}
SHEOF

RUN chmod +x /opt/kx-sandbox/execd /opt/kx-sandbox/start.sh /opt/kx-sandbox/execd-wrapper.sh \
    && find /opt/kuxuan/wechat-worker -type f -name '*.js' -exec chmod +x {} \;

# ------------------------------------------------------------------------------
# Default workspace
# ------------------------------------------------------------------------------
WORKDIR /workspace
EXPOSE 44772 8080 5900 6080
ENTRYPOINT ["/opt/kx-sandbox/start.sh"]
