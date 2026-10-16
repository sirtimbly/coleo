#!/usr/bin/env bash
set -euo pipefail

# Bootstrap only: the versioned standalone installer owns component/runtime installation.
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Required command missing: $1" >&2; exit 1; }
}
for cmd in curl uname mktemp chmod; do require_cmd "$cmd"; done
version="${COLEO_VERSION:-latest}"
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[$i]}" == --version ]]; then version="${args[$((i+1))]:-}"; fi
done
normalize_version() {
  case "$1" in
    coleo-v*) printf '%s' "${1#coleo-v}";;
    v*) printf '%s' "${1#v}";;
    *) printf '%s' "$1";;
  esac
}
version=$(normalize_version "$version")
base=https://github.com/sirtimbly/coleo/releases
if [[ "$version" == latest ]]; then
  resolved=$(curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL -o /dev/null -w '%{url_effective}' "$base/latest")
  version="${resolved##*/}"
  version=$(normalize_version "$version")
fi
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$ ]]; then
  echo 'Invalid release version' >&2; exit 1
fi
case "$(uname -s)" in Darwin) os=darwin;; Linux) os=linux;; *) echo 'Unsupported OS' >&2; exit 1;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64) arch=x64;; *) echo 'Unsupported architecture' >&2; exit 1;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
asset="coleo-installer-$os-$arch"
url="$base/download/coleo-v$version"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$url/$asset" -o "$tmp/$asset"
curl --proto '=https' --proto-redir '=https' --tlsv1.2 -fsSL "$url/SHA256SUMS" -o "$tmp/SHA256SUMS"
require_cmd awk
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$tmp/SHA256SUMS")
if [[ ! "$expected" =~ ^[a-f0-9]{64}$ ]]; then echo 'Missing installer checksum' >&2; exit 1; fi
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp/$asset"); actual="${actual%% *}"
else
  require_cmd shasum
  actual=$(shasum -a 256 "$tmp/$asset"); actual="${actual%% *}"
fi
[[ "$actual" == "$expected" ]] || { echo 'Installer checksum mismatch' >&2; exit 1; }
chmod 0755 "$tmp/$asset"
"$tmp/$asset" "${args[@]}" --version "$version"
