#!/usr/bin/env bash
set -euo pipefail

COLEO_DIR=${COLEO_DIR:-/home/coleo/.coleo}
PORT=${PORT:-3000}
R2_PREFIX=${COLEO_R2_PREFIX:-control}
mkdir -p "$COLEO_DIR"

configure_r2() {
  if [[ -z "${COLEO_R2_BUCKET:-}" ]]; then
    return
  fi
  export AWS_ACCESS_KEY_ID=${COLEO_R2_ACCESS_KEY_ID:-}
  export AWS_SECRET_ACCESS_KEY=${COLEO_R2_SECRET_ACCESS_KEY:-}
  export AWS_ENDPOINT_URL=${COLEO_R2_ENDPOINT:-}
  export AWS_DEFAULT_REGION=auto
}

restore_state() {
  if [[ -z "${COLEO_R2_BUCKET:-}" ]]; then
    return
  fi

  if aws s3 ls "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" >/dev/null 2>&1; then
    aws s3 sync "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" "$COLEO_DIR/"
  else
    # One-time compatibility path for workspaces created by the combined image.
    aws s3 sync "s3://${COLEO_R2_BUCKET}/" "$COLEO_DIR/" \
      --exclude "agent/*" --exclude "control/*" || true
  fi
}

sync_state() {
  if [[ -n "${COLEO_R2_BUCKET:-}" ]]; then
    aws s3 sync "$COLEO_DIR/" "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" || true
  fi
}

configure_r2
restore_state

if [[ -n "${COLEO_API_KEY:-}" ]]; then
  printf 'COLEO_API_KEY=%s\n' "$COLEO_API_KEY" > "$COLEO_DIR/.env"
fi

API_PID=""
BRAIN_PID=""
cleanup() {
  trap - TERM INT EXIT
  [[ -n "$BRAIN_PID" ]] && kill -TERM "$BRAIN_PID" 2>/dev/null || true
  [[ -n "$API_PID" ]] && kill -TERM "$API_PID" 2>/dev/null || true
  [[ -n "$BRAIN_PID" ]] && wait "$BRAIN_PID" 2>/dev/null || true
  [[ -n "$API_PID" ]] && wait "$API_PID" 2>/dev/null || true
  sync_state
}
trap cleanup TERM INT EXIT

echo "Starting Coleo API, web UI, and brain on port ${PORT}..."
coleo serve --host 0.0.0.0 --port "$PORT" &
API_PID=$!

for _ in $(seq 1 120); do
  if ! kill -0 "$API_PID" 2>/dev/null; then
    echo "Coleo API exited before becoming ready" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
  echo "Timed out waiting for Coleo API readiness" >&2
  exit 1
fi

coleo brain run &
BRAIN_PID=$!

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$BRAIN_PID" 2>/dev/null; do
  sleep 60
  sync_state
done

echo "A Coleo control process exited unexpectedly" >&2
exit 1
