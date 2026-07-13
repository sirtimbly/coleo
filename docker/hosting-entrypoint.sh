#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[coleo-docker] %s\n' "$*"
}

run_as_coleo() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash coleo -c "$*"
  else
    bash -lc "$*"
  fi
}

COLEO_HOME=${COLEO_HOME:-/home/coleo}
COLEO_APP_DIR=${COLEO_APP_DIR:-$COLEO_HOME/coleo}
COLEO_DIR=${COLEO_DIR:-$COLEO_HOME/.coleo}
COLEO_PROJECTS_DIR=${COLEO_PROJECTS_DIR:-$COLEO_HOME/projects}
COLEO_WORKDIR=${COLEO_WORKDIR:-$COLEO_PROJECTS_DIR/app}
COLEO_API_HOST=${COLEO_API_HOST:-0.0.0.0}
COLEO_API_PORT=${COLEO_API_PORT:-8080}
COLEO_WEB_HOST=${COLEO_WEB_HOST:-0.0.0.0}
COLEO_WEB_PORT=${COLEO_WEB_PORT:-5173}
COLEO_AGENT_MAX_ARMS=${COLEO_AGENT_MAX_ARMS:-10}
COLEO_NATS_URL=${COLEO_NATS_URL:-nats://nats:4222}

export COLEO_DIR COLEO_WORKDIR COLEO_API_HOST COLEO_API_PORT COLEO_NATS_URL
export COLEO_API_URL=${COLEO_API_URL:-http://127.0.0.1:${COLEO_API_PORT}}
export COLEO_CLI_ENTRYPOINT=${COLEO_CLI_ENTRYPOINT:-$COLEO_APP_DIR/src/cli/index.ts}
export PATH="$COLEO_HOME/.bun/bin:$PATH"

mkdir -p "$COLEO_DIR" "$COLEO_PROJECTS_DIR" "$COLEO_HOME/.local/share/opencode"
chown -R coleo:coleo "$COLEO_DIR" "$COLEO_PROJECTS_DIR" "$COLEO_HOME/.local" 2>/dev/null || true

if [ -n "${COLEO_GIT_REPO_URL:-}" ] && [ ! -d "$COLEO_WORKDIR/.git" ]; then
  log "Cloning COLEO_GIT_REPO_URL into $COLEO_WORKDIR"
  rm -rf "$COLEO_WORKDIR"
  run_as_coleo "git clone ${COLEO_GIT_CLONE_ARGS:-} '$COLEO_GIT_REPO_URL' '$COLEO_WORKDIR'"
  if [ -n "${COLEO_GIT_REF:-}" ]; then
    run_as_coleo "cd '$COLEO_WORKDIR' && git checkout '$COLEO_GIT_REF'"
  fi
elif [ -d "$COLEO_WORKDIR/.git" ] && [ "${COLEO_GIT_PULL_ON_START:-0}" = "1" ]; then
  log "Updating existing checkout in $COLEO_WORKDIR"
  run_as_coleo "cd '$COLEO_WORKDIR' && git pull --ff-only"
fi

if [ "${COLEO_INIT_ON_START:-1}" = "1" ] && [ ! -f "$COLEO_DIR/config.toml" ]; then
  log "Initializing Coleo state in $COLEO_DIR"
  run_as_coleo "cd '$COLEO_APP_DIR' && bun '$COLEO_CLI_ENTRYPOINT' init --dir '$COLEO_DIR' --non-interactive"
fi

if [ "${COLEO_START_SSH:-0}" = "1" ] && [ "$(id -u)" = "0" ]; then
  log "Starting sshd"
  /usr/sbin/sshd
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

pids=()
cleanup() {
  log "Stopping services"
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait || true
}
trap cleanup INT TERM EXIT

log "Starting API on ${COLEO_API_HOST}:${COLEO_API_PORT}"
run_as_coleo "cd '$COLEO_APP_DIR' && bun '$COLEO_CLI_ENTRYPOINT' serve --host '$COLEO_API_HOST' --port '$COLEO_API_PORT'" &
pids+=("$!")

log "Starting web UI on ${COLEO_WEB_HOST}:${COLEO_WEB_PORT}"
run_as_coleo "cd '$COLEO_APP_DIR' && bun '$COLEO_CLI_ENTRYPOINT' web --host '$COLEO_WEB_HOST' --port '$COLEO_WEB_PORT'" &
pids+=("$!")

if [ "${COLEO_START_BRAIN:-1}" = "1" ]; then
  log "Starting brain"
  run_as_coleo "cd '$COLEO_APP_DIR' && bun '$COLEO_CLI_ENTRYPOINT' brain run" &
  pids+=("$!")
fi

if [ "${COLEO_START_AGENT:-1}" = "1" ]; then
  log "Starting OpenCode arm agent"
  run_as_coleo "cd '$COLEO_WORKDIR' && bun '$COLEO_CLI_ENTRYPOINT' agent start --nats-url '$COLEO_NATS_URL' --max-arms '$COLEO_AGENT_MAX_ARMS'" &
  pids+=("$!")
fi

wait -n "${pids[@]}"
exit $?
