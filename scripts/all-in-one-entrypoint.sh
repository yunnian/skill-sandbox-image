#!/usr/bin/env bash

set -euo pipefail

JUPYTER_HOST="${JUPYTER_HOST:-http://127.0.0.1:44771}"
JUPYTER_PORT="${JUPYTER_PORT:-44771}"
JUPYTER_TOKEN="${JUPYTER_TOKEN:-opensandboxcodeinterpreterjupyter}"
EXECD_PORT="${EXECD_PORT:-44772}"
EXECD_LOG_LEVEL="${EXECD_LOG_LEVEL:-6}"

export JUPYTER_HOST JUPYTER_PORT JUPYTER_TOKEN

/opt/opensandbox/code-interpreter.sh &
jupyter_pid=$!

cleanup() {
  if kill -0 "${jupyter_pid}" >/dev/null 2>&1; then
    kill "${jupyter_pid}" >/dev/null 2>&1 || true
    wait "${jupyter_pid}" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

execd_args=(
  "--jupyter-host=${JUPYTER_HOST}"
  "--jupyter-token=${JUPYTER_TOKEN}"
  "--port=${EXECD_PORT}"
  "--log-level=${EXECD_LOG_LEVEL}"
)

if [ -n "${EXECD_ACCESS_TOKEN:-}" ]; then
  execd_args+=("--access-token=${EXECD_ACCESS_TOKEN}")
fi

exec /opt/opensandbox/execd "${execd_args[@]}" "$@"
