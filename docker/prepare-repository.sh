#!/usr/bin/env bash
set -euo pipefail

# No reset, pull, clean, or deletion of a user's checkout happens here.
workdir=${COLEO_WORKDIR:?COLEO_WORKDIR is required}
repository=${COLEO_GIT_REPO_URL:-}
[[ -n "$repository" ]] || exit 0
while [[ "$workdir" != / && "$workdir" == */ ]]; do workdir=${workdir%/}; done
[[ "$workdir" = /* && "$workdir" != / && ! -L "$workdir" ]] || { echo 'Unsafe workspace path' >&2; exit 1; }
parent=$(dirname "$workdir")
mkdir -p "$parent"

normalize_remote() {
  local value=${1%/}
  value=${value%.git}
  if [[ "$value" =~ ^git@github.com:(.+)$ ]]; then value="https://github.com/${BASH_REMATCH[1]}"; fi
  if [[ "$value" =~ ^ssh://git@github.com/(.+)$ ]]; then value="https://github.com/${BASH_REMATCH[1]}"; fi
  if [[ "$value" == https://github.com/* ]]; then value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]'); fi
  printf '%s' "$value"
}

conflict=0
if [[ -e "$workdir" ]]; then
  [[ -d "$workdir" ]] || { echo 'Workspace path is not a directory; manual recovery required' >&2; exit 1; }
  if [[ -n "$(find "$workdir" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
    conflict=1
    # A .git file (worktree) is valid too. Never mistake a parent repository for this checkout.
    if [[ -e "$workdir/.git" ]]; then
      root=$(git -C "$workdir" rev-parse --show-toplevel 2>/dev/null || true)
      remote=$(git -C "$workdir" remote get-url origin 2>/dev/null || true)
      if [[ -n "$root" && "$root" == "$(cd "$workdir" && pwd -P)" && -n "$remote" && "$(normalize_remote "$remote")" == "$(normalize_remote "$repository")" ]]; then
        # Use the authenticated HTTPS transport selected by Reef, including for
        # existing SSH remotes, without fetching or changing working files.
        git -C "$workdir" remote set-url origin "$repository"
        echo 'Keeping existing matching repository and local changes'
        exit 0
      fi
    fi
  fi
fi

request=${COLEO_GIT_REPLACEMENT_REQUEST:-}
if [[ "$conflict" == 1 && ! "$request" =~ ^[a-f0-9-]{36}$ ]]; then
  echo 'Repository setup blocked: existing files or a different checkout. Confirm Replace conflicting files in Reef.' >&2
  exit 1
fi

staging=$(mktemp -d "${workdir}.clone.XXXXXX")
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
clone_args=()
if [[ -n "${COLEO_GIT_CLONE_ARGS:-}" ]]; then read -r -a clone_args <<< "$COLEO_GIT_CLONE_ARGS"; fi
git clone "${clone_args[@]}" -- "$repository" "$staging"
if [[ -n "${COLEO_GIT_REF:-}" ]]; then git -C "$staging" checkout "$COLEO_GIT_REF"; fi

if [[ "$conflict" == 1 ]]; then
  approval=$(curl -fsS --max-time 20 -X POST \
    -H "x-coleo-api-key: ${COLEO_API_KEY:?COLEO_API_KEY is required}" \
    -H "x-coleo-replacement-request: $request" \
    -H "x-coleo-repository-url: $repository" \
    "${COLEO_API_URL:?COLEO_API_URL is required}/github/replacement-approval")
  [[ "$approval" == approved ]] || { echo 'Replacement not approved' >&2; exit 1; }
  backups="$parent/.coleo-repository-backups"
  [[ ! -L "$backups" ]] || { echo 'Unsafe backup path' >&2; exit 1; }
  mkdir -p "$backups"
  backup=$(mktemp -d "$backups/replacement.XXXXXX")
  mv -- "$workdir" "$backup/workspace"
  if ! mv -- "$staging" "$workdir"; then
    mv -- "$backup/workspace" "$workdir"
    exit 1
  fi
  echo "Previous working directory preserved at $backup/workspace"
else
  # rmdir refuses a directory populated while cloning; never remove its contents.
  if [[ -e "$workdir" ]]; then rmdir -- "$workdir"; fi
  mv -- "$staging" "$workdir"
fi
trap - EXIT
