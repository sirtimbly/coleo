#!/bin/sh
set -eu

COLEO_DIR="${COLEO_DIR:-/home/coleo/.coleo}"
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

cleanup() {
  sync_back
  kill -TERM "$COLEO_PID" 2>/dev/null || true
}

trap cleanup TERM INT

coleo serve &
COLEO_PID=$!

while kill -0 "$COLEO_PID" 2>/dev/null; do
  sleep 60
  sync_back
done

if wait "$COLEO_PID"; then
  COLEO_EXIT=0
else
  COLEO_EXIT=$?
fi
sync_back
exit "$COLEO_EXIT"
