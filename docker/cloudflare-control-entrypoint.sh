#!/usr/bin/env bash
set -euo pipefail

COLEO_DIR=${COLEO_DIR:-/home/coleo/.coleo}
PORT=${PORT:-3000}
R2_PREFIX=${COLEO_R2_PREFIX:-control}
QDRANT_URL=${COLEO_QDRANT_URL:-http://127.0.0.1:6333}
QDRANT_PORT=${COLEO_QDRANT_PORT:-6333}
QDRANT_DIR=${COLEO_QDRANT_DIR:-${COLEO_DIR}/qdrant}
QDRANT_STORAGE_DIR=${COLEO_QDRANT_STORAGE_DIR:-${QDRANT_DIR}/storage}
QDRANT_SNAPSHOT_DIR=${COLEO_QDRANT_SNAPSHOT_DIR:-/tmp/qdrant-snapshots}
QDRANT_BACKUP_FILE=${COLEO_QDRANT_BACKUP_FILE:-${QDRANT_DIR}/latest.snapshot}
QDRANT_CONFIG=${COLEO_QDRANT_CONFIG:-/tmp/qdrant-config.yaml}
QDRANT_SNAPSHOT_INTERVAL_SECONDS=${COLEO_QDRANT_SNAPSHOT_INTERVAL_SECONDS:-300}
mkdir -p "$COLEO_DIR" "$QDRANT_DIR" "$QDRANT_STORAGE_DIR" "$QDRANT_SNAPSHOT_DIR"

if [[ ! "$QDRANT_SNAPSHOT_INTERVAL_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "COLEO_QDRANT_SNAPSHOT_INTERVAL_SECONDS must be a positive integer" >&2
  exit 1
fi

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
    aws s3 sync "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" "$COLEO_DIR/" \
      --exclude "qdrant/storage/*"
  else
    # One-time compatibility path for workspaces created by the combined image.
    aws s3 sync "s3://${COLEO_R2_BUCKET}/" "$COLEO_DIR/" \
      --exclude "agent/*" --exclude "control/*" --exclude "qdrant/storage/*" || true
  fi
}

sync_state() {
  if [[ -n "${COLEO_R2_BUCKET:-}" ]]; then
    # Qdrant storage is a live database. Persist only its consistent snapshot.
    aws s3 sync "$COLEO_DIR/" "s3://${COLEO_R2_BUCKET}/${R2_PREFIX}/" \
      --exclude "qdrant/storage/*" || true
  fi
}

snapshot_qdrant() {
  if [[ -z "${QDRANT_PID:-}" ]] || ! kill -0 "$QDRANT_PID" 2>/dev/null; then
    return
  fi

  local response snapshot_name snapshot_file
  if ! response=$(curl -fsS -X POST "${QDRANT_URL}/snapshots?wait=true"); then
    echo "Failed to create Qdrant snapshot" >&2
    return
  fi
  if ! snapshot_name=$(bun -e '
    const payload = JSON.parse(await Bun.stdin.text());
    if (typeof payload?.result?.name !== "string") process.exit(1);
    process.stdout.write(payload.result.name);
  ' <<<"$response"); then
    echo "Qdrant returned an invalid snapshot response" >&2
    return
  fi

  snapshot_file="${QDRANT_SNAPSHOT_DIR}/${snapshot_name}"
  if [[ ! -f "$snapshot_file" ]]; then
    echo "Qdrant snapshot file was not created: ${snapshot_file}" >&2
    return
  fi
  cp "$snapshot_file" "${QDRANT_BACKUP_FILE}.tmp"
  mv "${QDRANT_BACKUP_FILE}.tmp" "$QDRANT_BACKUP_FILE"
  rm -f "$QDRANT_SNAPSHOT_DIR"/*.snapshot
  echo "Saved Qdrant snapshot ${snapshot_name}"
}

configure_r2
restore_state
rm -f "$COLEO_DIR/run/indexer.pid"

if [[ -n "${COLEO_API_KEY:-}" ]]; then
  printf 'COLEO_API_KEY=%s\n' "$COLEO_API_KEY" > "$COLEO_DIR/.env"
fi

cat > "$QDRANT_CONFIG" <<EOF
storage:
  storage_path: ${QDRANT_STORAGE_DIR}
  snapshots_path: ${QDRANT_SNAPSHOT_DIR}
service:
  host: 127.0.0.1
  http_port: ${QDRANT_PORT}
  grpc_port: null
telemetry_disabled: true
EOF

export COLEO_QDRANT_URL="$QDRANT_URL"

QDRANT_PID=""
API_PID=""
BRAIN_PID=""
INDEXER_PID=""
# shellcheck disable=SC2317 # Invoked indirectly by the signal/exit trap below.
cleanup() {
  trap - TERM INT EXIT
  if [[ -n "$INDEXER_PID" ]]; then kill -TERM "$INDEXER_PID" 2>/dev/null || true; fi
  if [[ -n "$BRAIN_PID" ]]; then kill -TERM "$BRAIN_PID" 2>/dev/null || true; fi
  if [[ -n "$API_PID" ]]; then kill -TERM "$API_PID" 2>/dev/null || true; fi
  if [[ -n "$INDEXER_PID" ]]; then wait "$INDEXER_PID" 2>/dev/null || true; fi
  if [[ -n "$BRAIN_PID" ]]; then wait "$BRAIN_PID" 2>/dev/null || true; fi
  if [[ -n "$API_PID" ]]; then wait "$API_PID" 2>/dev/null || true; fi
  snapshot_qdrant
  if [[ -n "$QDRANT_PID" ]]; then kill -TERM "$QDRANT_PID" 2>/dev/null || true; fi
  if [[ -n "$QDRANT_PID" ]]; then wait "$QDRANT_PID" 2>/dev/null || true; fi
  rm -f "$COLEO_DIR/run/indexer.pid"
  sync_state
}
# shellcheck disable=SC2317 # Invoked indirectly by the signal trap below.
shutdown() {
  cleanup
  exit 0
}
trap shutdown TERM INT
trap cleanup EXIT

qdrant_args=(--config-path "$QDRANT_CONFIG" --disable-telemetry)
if [[ -f "$QDRANT_BACKUP_FILE" && ! -d "$QDRANT_STORAGE_DIR/collections" ]]; then
  echo "Restoring Qdrant from the latest R2 snapshot..."
  qdrant_args+=(--storage-snapshot "$QDRANT_BACKUP_FILE")
fi

echo "Starting Qdrant on port ${QDRANT_PORT}..."
qdrant "${qdrant_args[@]}" &
QDRANT_PID=$!

for _ in $(seq 1 120); do
  if ! kill -0 "$QDRANT_PID" 2>/dev/null; then
    echo "Qdrant exited before becoming ready" >&2
    exit 1
  fi
  if curl -fsS "${QDRANT_URL}/readyz" >/dev/null; then
    break
  fi
  sleep 1
done

if ! curl -fsS "${QDRANT_URL}/readyz" >/dev/null; then
  echo "Timed out waiting for Qdrant readiness" >&2
  exit 1
fi

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

echo "Starting transcript indexer..."
bun /home/coleo/coleo/src/scripts/jetstream-transcript-indexer.ts &
INDEXER_PID=$!
mkdir -p "$COLEO_DIR/run"
# shellcheck disable=SC2016 # The JavaScript reads environment variables at runtime.
COLEO_DIR="$COLEO_DIR" INDEXER_PID="$INDEXER_PID" INDEXER_CWD="/home/coleo/coleo" bun -e '
  const path = `${process.env.COLEO_DIR}/run/indexer.pid`;
  await Bun.write(path, JSON.stringify({
    type: "indexer",
    pid: Number(process.env.INDEXER_PID),
    startedAt: new Date().toISOString(),
    command: [process.execPath, "src/scripts/jetstream-transcript-indexer.ts"],
    cwd: process.env.INDEXER_CWD,
  }, null, 2));
'

coleo brain run &
BRAIN_PID=$!

last_qdrant_snapshot=$SECONDS
while kill -0 "$QDRANT_PID" 2>/dev/null \
  && kill -0 "$API_PID" 2>/dev/null \
  && kill -0 "$INDEXER_PID" 2>/dev/null \
  && kill -0 "$BRAIN_PID" 2>/dev/null; do
  sleep 60
  if (( SECONDS - last_qdrant_snapshot >= QDRANT_SNAPSHOT_INTERVAL_SECONDS )); then
    snapshot_qdrant
    last_qdrant_snapshot=$SECONDS
  fi
  sync_state
done

echo "A Coleo control process exited unexpectedly" >&2
exit 1
