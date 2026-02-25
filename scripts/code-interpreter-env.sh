#!/usr/bin/env bash

set -euo pipefail

PYTHON_VERSION="${PYTHON_VERSION:-3.12}"
JAVA_VERSION="${JAVA_VERSION:-21}"
NODE_VERSION="${NODE_VERSION:-22}"
GO_VERSION="${GO_VERSION:-1.25.5}"

print_versions() {
  echo "Single-version image:"
  echo "python=${PYTHON_VERSION}"
  echo "java=${JAVA_VERSION}"
  echo "node=${NODE_VERSION}"
  echo "go=${GO_VERSION}"
}

append_env_if_needed() {
  local key="$1"
  local value="$2"
  if [ -z "${EXECD_ENVS:-}" ]; then
    return
  fi
  mkdir -p "$(dirname "$EXECD_ENVS")" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$value" >>"$EXECD_ENVS" 2>/dev/null || true
}

set_java_home() {
  if [ -d "/usr/lib/jvm/java-${JAVA_VERSION}-openjdk-amd64" ]; then
    export JAVA_HOME="/usr/lib/jvm/java-${JAVA_VERSION}-openjdk-amd64"
  elif [ -d "/usr/lib/jvm/java-${JAVA_VERSION}-openjdk-arm64" ]; then
    export JAVA_HOME="/usr/lib/jvm/java-${JAVA_VERSION}-openjdk-arm64"
  fi
  if [ -n "${JAVA_HOME:-}" ]; then
    export PATH="${JAVA_HOME}/bin:${PATH}"
    append_env_if_needed JAVA_HOME "$JAVA_HOME"
    append_env_if_needed PATH "$PATH"
  fi
}

main() {
  local lang="${1:-}"
  local ver="${2:-}"

  if [ -z "$lang" ]; then
    print_versions
    return 0
  fi

  case "$lang" in
    python)
      if [ -n "$ver" ] && [ "$ver" != "$PYTHON_VERSION" ]; then
        echo "only python ${PYTHON_VERSION} is available"
        return 1
      fi
      ;;
    java)
      if [ -n "$ver" ] && [ "$ver" != "$JAVA_VERSION" ]; then
        echo "only java ${JAVA_VERSION} is available"
        return 1
      fi
      set_java_home
      ;;
    node)
      if [ -n "$ver" ] && [ "$ver" != "$NODE_VERSION" ]; then
        echo "only node ${NODE_VERSION} is available"
        return 1
      fi
      ;;
    go)
      if [ -n "$ver" ] && [ "$ver" != "$GO_VERSION" ]; then
        echo "only go ${GO_VERSION} is available"
        return 1
      fi
      export PATH="/usr/local/go/bin:/root/go/bin:${PATH}"
      append_env_if_needed PATH "$PATH"
      ;;
    *)
      echo "usage: source /opt/opensandbox/code-interpreter-env.sh [python|java|node|go] [version]"
      return 1
      ;;
  esac
}

main "${1:-}" "${2:-}"
