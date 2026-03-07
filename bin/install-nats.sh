#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

require_cmd curl
require_cmd tar
require_cmd uname
require_cmd mktemp
require_cmd install

NATS_VERSION="${NATS_VERSION:-2.12.3}"
NATS_VERSION="${NATS_VERSION#v}"
COLEO_DIR="${COLEO_DIR:-${PWD}/.coleo}"
INSTALL_ROOT="${COLEO_BIN_DIR:-${COLEO_DIR}/bin}"

os="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch="$(uname -m)"

case "${os}" in
  darwin|linux) ;;
  *)
    echo "Unsupported OS: ${os}" >&2
    exit 1
    ;;
esac

case "${arch}" in
  x86_64|amd64)
    arch="amd64"
    ;;
  arm64|aarch64)
    arch="arm64"
    ;;
  *)
    echo "Unsupported architecture: ${arch}" >&2
    exit 1
    ;;
esac

archive="nats-server-v${NATS_VERSION}-${os}-${arch}.tar.gz"
base_url="https://github.com/nats-io/nats-server/releases/download/v${NATS_VERSION}"
download_url="${base_url}/${archive}"
tmp_dir="$(mktemp -d)"
archive_path="${tmp_dir}/${archive}"

cleanup() {
  rm -rf "${tmp_dir}"
}
trap cleanup EXIT

mkdir -p "${INSTALL_ROOT}"

echo "Downloading ${download_url}"
curl -fsSL "${download_url}" -o "${archive_path}"

tar -xzf "${archive_path}" -C "${tmp_dir}"
src_dir="${tmp_dir}/nats-server-v${NATS_VERSION}-${os}-${arch}"
src_bin="${src_dir}/nats-server"
dst_bin="${INSTALL_ROOT}/nats-server"

if [[ ! -x "${src_bin}" ]]; then
  echo "Failed to find extracted nats-server binary" >&2
  exit 1
fi

install -m 0755 "${src_bin}" "${dst_bin}"

echo "Installed nats-server to ${dst_bin}"
echo "Version: $("${dst_bin}" -v)"
