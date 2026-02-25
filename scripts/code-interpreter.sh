#!/usr/bin/env bash

set -euo pipefail

export PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

if [ -n "${EXECD_ENVS:-}" ]; then
  mkdir -p "$(dirname "$EXECD_ENVS")" 2>/dev/null || true
  printf 'PATH=%s\n' "$PATH" >>"$EXECD_ENVS" 2>/dev/null || true
fi

exec jupyter notebook \
  --ip=127.0.0.1 \
  --port="${JUPYTER_PORT:-44771}" \
  --allow-root \
  --no-browser \
  --NotebookApp.token="${JUPYTER_TOKEN:-opensandboxcodeinterpreterjupyter}" \
  >/opt/opensandbox/jupyter.log 2>&1
