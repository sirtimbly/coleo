#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT_DIR/docker-compose.cloudflare-local.yml"
CONTROL_URL=${COLEO_LOCAL_CONTROL_URL:-http://127.0.0.1:13000}
API_KEY=${COLEO_LOCAL_API_KEY:-local-reef-api-key}
TEST_REPOSITORY=${COLEO_LOCAL_TEST_REPOSITORY:-https://github.com/octocat/Hello-World.git}

compose() {
  docker compose --file "$COMPOSE_FILE" "$@"
}

api() {
  curl -fsS \
    --header "X-API-Key: $API_KEY" \
    --header "Content-Type: application/json" \
    "$@"
}

wait_for_onboarding() {
  local response=""
  for _ in $(seq 1 90); do
    if response=$(api "$CONTROL_URL/api/onboarding" 2>/dev/null); then
      printf '%s\n' "$response"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for Control to connect to the Arm Host" >&2
  compose logs --tail 200 control arm-host >&2
  return 1
}

wait_for_arm_host() {
  local response=""
  for _ in $(seq 1 90); do
    if response=$(api "$CONTROL_URL/api/agents" 2>/dev/null) \
      && [[ "$response" == *'"agentId":"reef-local-workspace"'* ]]; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for the Arm Host to register with Control" >&2
  compose logs --tail 200 control arm-host >&2
  return 1
}

assert_status() {
  local response=$1
  local expected_ready=$2
  # shellcheck disable=SC2016 # JavaScript reads these values from process.env.
  compose exec --no-TTY \
    --env "RESPONSE=$response" \
    --env "EXPECTED_READY=$expected_ready" \
    control bun -e '
    const status = JSON.parse(process.env.RESPONSE || "{}");
    const expectedReady = process.env.EXPECTED_READY === "true";
    if (status.projectDir !== "/home/coleo/runtime/workspace") {
      throw new Error(`Unexpected project directory: ${status.projectDir}`);
    }
    if (status.ready !== expectedReady) {
      throw new Error(`Expected ready=${expectedReady}, received ${status.ready}`);
    }
  '
}

smoke() {
  local initial clone_result final

  echo "Waiting for the Arm Host to register with Control..."
  wait_for_arm_host
  echo "Checking remote onboarding through Control..."
  initial=$(wait_for_onboarding)
  assert_status "$initial" false

  echo "Cloning $TEST_REPOSITORY through the remote Arm Host..."
  clone_result=$(api \
    --request POST \
    --data "$(printf '{\"repositoryUrl\":\"%s\"}' "$TEST_REPOSITORY")" \
    "$CONTROL_URL/api/onboarding/clone")
  assert_status "$clone_result" true

  final=$(api "$CONTROL_URL/api/onboarding")
  assert_status "$final" true

  compose exec --no-TTY arm-host \
    test -d /home/coleo/runtime/workspace/.git
  compose exec --no-TTY control \
    test ! -e /home/coleo/runtime/workspace/.git

  echo "Remote onboarding passed. The checkout exists only in the Arm Host."
  printf '%s\n' "$final"
}

usage() {
  cat <<'EOF'
Usage: bin/cloudflare-split-local.sh <command>

Commands:
  build   Build the production Control and Arm Host images locally
  up      Start the split runtime in the background
  smoke   Clone a public repository through Control and verify ownership
  status  Show container state
  logs    Follow both container logs
  down    Stop the stack while preserving local state
  reset   Stop the stack and delete its local state volumes
EOF
}

case "${1:-}" in
  build)
    compose build
    ;;
  up)
    compose up --detach --wait
    wait_for_arm_host
    ;;
  smoke)
    smoke
    ;;
  status)
    compose ps
    ;;
  logs)
    compose logs --follow control arm-host
    ;;
  down)
    compose down
    ;;
  reset)
    compose down --volumes --remove-orphans
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
