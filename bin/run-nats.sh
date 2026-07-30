#!/usr/bin/env bash
set -euo pipefail

COLEO_DIR="${COLEO_DIR:-${PWD}/.coleo}"
BIN_DIR="${COLEO_BIN_DIR:-${COLEO_DIR}/bin}"
NATS_BIN="${NATS_BIN:-${BIN_DIR}/nats-server}"
NATS_DATA_DIR="${COLEO_NATS_DATA_DIR:-${COLEO_DIR}/nats}"
NATS_HOST="${COLEO_NATS_HOST:-127.0.0.1}"
NATS_PORT="${COLEO_NATS_PORT:-4222}"
NATS_HTTP_PORT="${COLEO_NATS_HTTP_PORT:-8222}"

if [[ ! -x "${NATS_BIN}" ]]; then
  echo "nats-server not found at ${NATS_BIN}" >&2
  echo "Installing pinned local binary..." >&2
  COLEO_BIN_DIR="${BIN_DIR}" bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install-nats.sh"
fi

mkdir -p "${NATS_DATA_DIR}"

exec "${NATS_BIN}" \
  -js \
  -sd "${NATS_DATA_DIR}" \
  -a "${NATS_HOST}" \
  -p "${NATS_PORT}" \
  --http_port "${NATS_HTTP_PORT}"
