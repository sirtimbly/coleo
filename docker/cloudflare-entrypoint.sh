#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required command not found: $1" >&2; exit 1; }
}
require_cmd coleo
require_cmd coleo-web
require_cmd curl

COLEO_DIR="${COLEO_DIR:-/home/coleo/.coleo}"
PORT="${PORT:-3000}"
API_PORT="${COLEO_API_INTERNAL_PORT:-8081}"
if [ "$API_PORT" = "$PORT" ]; then
  echo "COLEO_API_INTERNAL_PORT must differ from PORT" >&2
  exit 1
fi
mkdir -p "$COLEO_DIR"

if [ -n "${COLEO_R2_BUCKET:-}" ]; then
  export AWS_ACCESS_KEY_ID="${COLEO_R2_ACCESS_KEY_ID:-}"
  export AWS_SECRET_ACCESS_KEY="${COLEO_R2_SECRET_ACCESS_KEY:-}"
  export AWS_ENDPOINT_URL="${COLEO_R2_ENDPOINT:-}"
  export AWS_DEFAULT_REGION="auto"
  aws s3 sync "s3://$COLEO_R2_BUCKET/" "$COLEO_DIR/" || true
fi

if [ -n "${COLEO_API_KEY:-}" ]; then
  printf 'COLEO_API_KEY=%s\n' "$COLEO_API_KEY" > "$COLEO_DIR/.env"
fi

sync_back() {
  if [ -n "${COLEO_R2_BUCKET:-}" ]; then
    aws s3 sync "$COLEO_DIR/" "s3://$COLEO_R2_BUCKET/" || true
  fi
}

stop_nats() {
  NATS_PID_FILE="$COLEO_DIR/run/nats.pid"
  if [ -f "$NATS_PID_FILE" ]; then
    NATS_PID="$(sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$NATS_PID_FILE" | head -n 1)"
    if [ -n "$NATS_PID" ]; then
      kill -TERM "$NATS_PID" 2>/dev/null || true
    fi
  fi
}

shutdown() {
  trap - TERM INT
  kill -TERM "${BRAIN_PID:-}" 2>/dev/null || true
  kill -TERM "${API_PID:-}" 2>/dev/null || true
  kill -TERM "${WEB_PID:-}" 2>/dev/null || true
  stop_nats
  wait "${BRAIN_PID:-}" 2>/dev/null || true
  wait "${API_PID:-}" 2>/dev/null || true
  wait "${WEB_PID:-}" 2>/dev/null || true
  sync_back
}

trap 'shutdown; exit 0' TERM INT

echo "Starting Coleo API on internal port $API_PORT..."
coleo serve --host 127.0.0.1 --port "$API_PORT" &
API_PID=$!

echo "Waiting for Coleo API readiness..."
READY=0
for _ in $(seq 1 120); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Coleo API exited before becoming ready" >&2
    shutdown
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:$API_PORT/api/health" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "Timed out waiting for Coleo API readiness" >&2
  shutdown
  exit 1
fi

echo "Starting Coleo web/proxy on port $PORT..."
COLEO_API_URL="http://127.0.0.1:$API_PORT" coleo-web --host 0.0.0.0 --port "$PORT" &
WEB_PID=$!

echo "Starting Coleo brain..."
coleo brain run &
BRAIN_PID=$!

while :; do
  if ! kill -0 "$WEB_PID" 2>/dev/null; then
    echo "Coleo web host exited; stopping container" >&2
    shutdown
    exit 1
  fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Coleo API exited; stopping container" >&2
    shutdown
    exit 1
  fi
  if ! kill -0 "$BRAIN_PID" 2>/dev/null; then
    echo "Coleo brain exited; stopping container" >&2
    shutdown
    exit 1
  fi
  sleep 60
  sync_back
done
