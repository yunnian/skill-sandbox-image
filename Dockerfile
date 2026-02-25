# syntax=docker/dockerfile:1

FROM golang:1.24.0 AS execd-builder

WORKDIR /build
COPY execd/go.mod execd/go.sum ./
RUN go mod download
COPY execd/ ./
RUN CGO_ENABLED=0 go build -o /out/execd ./main.go

FROM ubuntu:24.04

ARG TARGETARCH

SHELL ["/bin/bash", "-c"]

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PYTHON_VERSION=3.12 \
    JAVA_VERSION=21 \
    NODE_VERSION=22 \
    GO_VERSION=1.25.5 \
    EXECD_PORT=44772 \
    EXECD_LOG_LEVEL=6

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

RUN if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i -E 's|http://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/ubuntu/?|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list.d/ubuntu.sources; \
    fi \
    && if [ -f /etc/apt/sources.list ]; then \
      sed -i -E 's|http://mirrors\\.tuna\\.tsinghua\\.edu\\.cn/ubuntu/?|https://mirrors.tuna.tsinghua.edu.cn/ubuntu/|g' /etc/apt/sources.list; \
    fi

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl wget unzip zip tar git build-essential \
    python3 python3-pip python3-venv \
    openjdk-21-jdk \
    fontconfig fonts-noto-cjk fonts-wqy-zenhei \
    && fc-cache -f \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*
# 装js第三方库
RUN set -euo pipefail \
    && npm install -g  openskills

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

ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

RUN ln -sf /usr/bin/python3 /usr/local/bin/python \
    && mkdir -p /opt/opensandbox

COPY --from=execd-builder /out/execd /opt/opensandbox/execd

RUN cat >/opt/opensandbox/start.sh <<'SHEOF'
#!/usr/bin/env bash
set -euo pipefail

execd_args=(
  "--port=${EXECD_PORT:-44772}"
  "--log-level=${EXECD_LOG_LEVEL:-6}"
)
if [ -n "${EXECD_ACCESS_TOKEN:-}" ]; then
  execd_args+=("--access-token=${EXECD_ACCESS_TOKEN}")
fi

exec /opt/opensandbox/execd "${execd_args[@]}" "$@"
SHEOF

RUN chmod +x /opt/opensandbox/execd /opt/opensandbox/start.sh

WORKDIR /workspace
EXPOSE 44772
ENTRYPOINT ["/opt/opensandbox/start.sh"]
