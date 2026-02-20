#!/usr/bin/env bash
set -euo pipefail

COLEO_VERSION="${COLEO_VERSION:-latest}"
INSTALL_BUN_VERSION="${INSTALL_BUN_VERSION:-}"

need_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: required command '$cmd' is not installed." >&2
    exit 1
  fi
}

install_bun() {
  need_cmd curl
  echo "Installing Bun runtime..."
  if [[ -n "$INSTALL_BUN_VERSION" ]]; then
    curl -fsSL https://bun.sh/install | bash -s -- "bun-v${INSTALL_BUN_VERSION}"
  else
    curl -fsSL https://bun.sh/install | bash
  fi
}

ensure_bun_on_path() {
  local bun_install_dir
  bun_install_dir="${BUN_INSTALL:-$HOME/.bun}"
  export BUN_INSTALL="$bun_install_dir"
  export PATH="$BUN_INSTALL/bin:$PATH"
}

install_coleo() {
  local package_spec
  if [[ "$COLEO_VERSION" == "latest" ]]; then
    package_spec="coleo"
  else
    package_spec="coleo@${COLEO_VERSION}"
  fi

  echo "Installing ${package_spec} globally..."
  bun install -g "$package_spec"
}

main() {
  if ! command -v bun >/dev/null 2>&1; then
    install_bun
  fi

  ensure_bun_on_path
  need_cmd bun

  install_coleo

  if command -v coleo >/dev/null 2>&1; then
    echo "Coleo installed: $(coleo --version)"
    echo "Next step: run 'coleo init' in your terminal."
  else
    echo "Coleo installed, but 'coleo' is not on PATH in this shell." >&2
    echo "Add '$BUN_INSTALL/bin' to PATH, then run: coleo --version" >&2
    exit 1
  fi
}

main "$@"
