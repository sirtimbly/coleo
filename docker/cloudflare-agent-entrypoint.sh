#!/usr/bin/env bash
set -euo pipefail

COLEO_RUNTIME_DIR=${COLEO_RUNTIME_DIR:-/home/coleo/runtime}
COLEO_DIR=${COLEO_DIR:-${COLEO_RUNTIME_DIR}/coleo}
COLEO_WORKDIR=${COLEO_WORKDIR:-${COLEO_RUNTIME_DIR}/workspace}
COLEO_NATS_STORE_DIR=${COLEO_NATS_STORE_DIR:-${COLEO_RUNTIME_DIR}/nats}
COLEO_NATS_PORT=${COLEO_NATS_PORT:-4222}
COLEO_NATS_WS_PORT=${COLEO_NATS_WS_PORT:-9222}
COLEO_NATS_MONITOR_PORT=${COLEO_NATS_MONITOR_PORT:-8222}
R2_PREFIX=${COLEO_R2_PREFIX:-agent}

if [[ -z "${COLEO_NATS_TOKEN:-}" ]]; then
  echo "COLEO_NATS_TOKEN is required" >&2
  exit 1
fi

mkdir -p "$COLEO_DIR" "$COLEO_WORKDIR" "$COLEO_NATS_STORE_DIR"

if [[ -n "${COLEO_R2_BUCKET:-}" ]]; then
  export AWS_ACCESS_KEY_ID=${COLEO_R2_ACCESS_KEY_ID:-}
  export AWS_SECRET_ACCESS_KEY=${COLEO_R2_SECRET_ACCESS_KEY:-}
  export AWS_ENDPOINT_URL=${COLEO_R2_ENDPOINT:-}
  export AWS_DEFAULT_REGION=auto
  aws s3 sync "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" "$COLEO_RUNTIME_DIR/" || true
fi

sync_state() {
  local mode=${1:-live}
  if [[ -n "${COLEO_R2_BUCKET:-}" ]]; then
    if [[ "$mode" == "full" ]]; then
      aws s3 sync "$COLEO_RUNTIME_DIR/" "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" || true
    else
      # JetStream mutates multiple files as a unit. Copy it only after NATS has
      # stopped cleanly; live syncs cover the checkout and agent configuration.
      aws s3 sync "$COLEO_RUNTIME_DIR/" "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" --exclude "nats/*" || true
    fi
  fi
}

if [[ -n "${COLEO_GIT_REPO_URL:-}" && ! -d "$COLEO_WORKDIR/.git" ]]; then
  rm -rf "$COLEO_WORKDIR"
  clone_args=()
  if [[ -n "${COLEO_GIT_CLONE_ARGS:-}" ]]; then
    read -r -a clone_args <<< "$COLEO_GIT_CLONE_ARGS"
  fi
  git clone "${clone_args[@]}" "$COLEO_GIT_REPO_URL" "$COLEO_WORKDIR"
  if [[ -n "${COLEO_GIT_REF:-}" ]]; then
    git -C "$COLEO_WORKDIR" checkout "$COLEO_GIT_REF"
  fi
fi

if [[ ! -f "$COLEO_DIR/config.toml" ]]; then
  coleo init --dir "$COLEO_DIR" --non-interactive
fi

NATS_CONFIG=${COLEO_RUNTIME_DIR}/nats.conf
cat > "$NATS_CONFIG" <<EOF
port: ${COLEO_NATS_PORT}
http_port: ${COLEO_NATS_MONITOR_PORT}
authorization {
  token: "${COLEO_NATS_TOKEN}"
}
jetstream {
  store_dir: "${COLEO_NATS_STORE_DIR}"
}
websocket {
  port: ${COLEO_NATS_WS_PORT}
  no_tls: true
  same_origin: false
}
EOF

export COLEO_NATS_URL="nats://127.0.0.1:${COLEO_NATS_PORT}"
export COLEO_API_URL=${COLEO_API_URL:?COLEO_API_URL is required}

NATS_PID=""
AGENT_PID=""
cleanup() {
  trap - TERM INT EXIT
  [[ -n "$AGENT_PID" ]] && kill -TERM -- "-$AGENT_PID" 2>/dev/null || true
  [[ -n "$AGENT_PID" ]] && wait "$AGENT_PID" 2>/dev/null || true
  [[ -n "$NATS_PID" ]] && kill -TERM "$NATS_PID" 2>/dev/null || true
  [[ -n "$NATS_PID" ]] && wait "$NATS_PID" 2>/dev/null || true
  sync_state full
}
trap cleanup TERM INT EXIT

nats-server -c "$NATS_CONFIG" &
NATS_PID=$!

for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${COLEO_NATS_MONITOR_PORT}/healthz" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${COLEO_NATS_MONITOR_PORT}/healthz" >/dev/null; then
  echo "Timed out waiting for NATS readiness" >&2
  exit 1
fi

cd "$COLEO_WORKDIR"
setsid coleo agent start \
  --id "reef-${COLEO_PROJECT_ID:-workspace}" \
  --nats-url "$COLEO_NATS_URL" \
  --max-arms "${COLEO_AGENT_MAX_ARMS:-10}" &
AGENT_PID=$!

while kill -0 "$NATS_PID" 2>/dev/null && kill -0 "$AGENT_PID" 2>/dev/null; do
  sleep 60
  sync_state
done

echo "A Coleo arm runtime process exited unexpectedly" >&2
exit 1
