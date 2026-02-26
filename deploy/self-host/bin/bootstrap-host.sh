#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
SELF_HOST_DIR="${ROOT_DIR}/deploy/self-host"
ENV_FILE="${SELF_HOST_DIR}/.env.hosting"

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd openssl
require_cmd awk

if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${SELF_HOST_DIR}/.env.hosting.example" "${ENV_FILE}"
fi

upsert_env() {
  local key="$1"
  local value="$2"
  if grep -qE "^${key}=" "${ENV_FILE}"; then
    awk -v key="${key}" -v value="${value}" 'BEGIN{FS=OFS="="} $1==key {$2=value} 1' "${ENV_FILE}" > "${ENV_FILE}.tmp"
    mv "${ENV_FILE}.tmp" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >> "${ENV_FILE}"
  fi
}

bootstrap_token="$(openssl rand -hex 24)"
api_key="$(openssl rand -base64 32 | tr -d '\n')"
auth_jwt="$(openssl rand -hex 32)"
auth_session="$(openssl rand -hex 32)"
auth_storage="$(openssl rand -hex 32)"
auth_hmac="$(openssl rand -hex 32)"

upsert_env COLEO_BOOTSTRAP_TOKEN "${bootstrap_token}"
upsert_env COLEO_API_KEY "${api_key}"
upsert_env AUTH_JWT_SECRET "${auth_jwt}"
upsert_env AUTH_SESSION_SECRET "${auth_session}"
upsert_env AUTH_STORAGE_ENCRYPTION_KEY "${auth_storage}"
upsert_env AUTH_HMAC_SECRET "${auth_hmac}"

set -a
source "${ENV_FILE}"
set +a

if command -v envsubst >/dev/null 2>&1; then
  envsubst < "${SELF_HOST_DIR}/authelia/configuration.yml.tmpl" > "${SELF_HOST_DIR}/authelia/configuration.yml"
  envsubst < "${SELF_HOST_DIR}/authelia/users_database.yml.tmpl" > "${SELF_HOST_DIR}/authelia/users_database.yml"
  envsubst < "${SELF_HOST_DIR}/tailscale/serve.json.tmpl" > "${SELF_HOST_DIR}/tailscale/serve.json"
else
  echo "Warning: envsubst not found. Install gettext to render config templates." >&2
fi

echo "Bootstrap complete."
echo "Saved: ${ENV_FILE}"
echo
echo "Initial setup token (save this securely):"
echo "  ${bootstrap_token}"
echo
echo "Start stack:"
echo "  docker compose --env-file deploy/self-host/.env.hosting -f deploy/self-host/docker-compose.hosting.yml up -d --build"
