#!/usr/bin/env bash
set -euo pipefail
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required command missing: $1" >&2; exit 1; }
}
require_cmd bash
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bash "$script_dir/install.sh" uninstall "$@"
