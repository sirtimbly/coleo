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

get_env() {
  local key="$1"
  awk -v key="${key}" '
    index($0, key "=") == 1 {
      print substr($0, length(key) + 2)
      exit
    }
  ' "${ENV_FILE}"
}

upsert_env() {
  local key="$1"
  local value="$2"
  awk -v key="${key}" -v value="${value}" '
    index($0, key "=") == 1 {
      print key "=" value
      replaced = 1
      next
    }
    { print }
    END {
      if (!replaced) {
        print key "=" value
      }
    }
  ' "${ENV_FILE}" > "${ENV_FILE}.tmp"
  mv "${ENV_FILE}.tmp" "${ENV_FILE}"
}

ensure_env() {
  local key="$1"
  local value="$2"
  shift 2
  local current
  current="$(get_env "${key}")"

  if [[ -z "${current}" ]]; then
    upsert_env "${key}" "${value}"
    return
  fi

  for placeholder in "$@"; do
    if [[ "${current}" == "${placeholder}" ]]; then
      upsert_env "${key}" "${value}"
      return
    fi
  done
}

bootstrap_token="$(openssl rand -hex 24)"
api_key="$(openssl rand -base64 32 | tr -d '\n')"
auth_jwt="$(openssl rand -hex 32)"
auth_session="$(openssl rand -hex 32)"
auth_storage="$(openssl rand -hex 32)"
auth_hmac="$(openssl rand -hex 32)"

ensure_env COLEO_BIND_HOST "127.0.0.1"
ensure_env COLEO_WEB_PORT "80"
ensure_env COLEO_PUBLIC_ORIGIN "http://localhost" "https://coleo.example.com"

ensure_env COLEO_BOOTSTRAP_TOKEN "${bootstrap_token}" "replace-with-generated-token"
ensure_env COLEO_API_KEY "${api_key}" "replace-with-generated-api-key"
ensure_env AUTH_JWT_SECRET "${auth_jwt}" "replace-with-generated-value"
ensure_env AUTH_SESSION_SECRET "${auth_session}" "replace-with-generated-value"
ensure_env AUTH_STORAGE_ENCRYPTION_KEY "${auth_storage}" "replace-with-generated-value"
ensure_env AUTH_HMAC_SECRET "${auth_hmac}" "replace-with-generated-value"

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

edge_ready="yes"
for required_key in COLEO_DOMAIN AUTH_DOMAIN ACME_EMAIL AUTH_ADMIN_PASSWORD_HASH; do
  current="$(get_env "${required_key}")"
  case "${current}" in
    ""|"coleo.example.com"|"auth.example.com"|"ops@example.com")
      edge_ready="no"
      ;;
  esac
done

echo "Bootstrap complete."
echo "Saved: ${ENV_FILE}"
echo
echo "Bootstrap token:"
echo "  $(get_env COLEO_BOOTSTRAP_TOKEN)"
echo
echo "API key:"
echo "  $(get_env COLEO_API_KEY)"
echo
echo "Start local/home-server stack:"
echo "  docker compose --env-file deploy/self-host/.env.hosting -f deploy/self-host/docker-compose.hosting.yml up -d --build"
echo
echo "For LAN/Tailscale/VPN access, set:"
echo "  COLEO_BIND_HOST=0.0.0.0"
echo "  COLEO_PUBLIC_ORIGIN=http://<your-host-or-tailscale-name>"

if [[ "${edge_ready}" == "yes" ]]; then
  echo
  echo "Optional public edge stack:"
  echo "  docker compose --env-file deploy/self-host/.env.hosting -f deploy/self-host/docker-compose.hosting.yml -f deploy/self-host/docker-compose.hosting.edge.example.yml up -d --build"
else
  echo
  echo "Edge overlay not fully configured yet."
  echo "Set COLEO_DOMAIN, AUTH_DOMAIN, ACME_EMAIL, and AUTH_ADMIN_PASSWORD_HASH before using docker-compose.hosting.edge.example.yml."
fi
