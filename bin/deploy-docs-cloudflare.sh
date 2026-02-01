#!/usr/bin/env bash
set -euo pipefail

# Deploy VitePress docs to Cloudflare using Workers (preferred) or Pages.
# Requires: `bun`, `bunx`, and `wrangler` (installed via bunx on first run).
#
# Env options:
#   CF_USE_PAGES=1          -> use Pages (legacy) instead of Workers Assets
#   CF_PAGES_PROJECT=name   -> Pages project name (if using Pages)
#   CF_PAGES_BRANCH=name    -> Pages branch (optional)
#   CF_WORKER_NAME=name     -> Override worker name
#   CF_PREVIEW=1            -> Use wrangler preview deployment (no routes)

set -euo pipefail

echo "Building docs..."
bun run docs:build

if [[ "${CF_USE_PAGES:-0}" == "1" ]]; then
  PROJECT_NAME=${CF_PAGES_PROJECT:-coleo-docs}
  BRANCH_FLAG=""
  if [[ -n "${CF_PAGES_BRANCH:-}" ]]; then
    BRANCH_FLAG=(--branch "${CF_PAGES_BRANCH}")
  fi
  echo "Deploying to Cloudflare Pages (project: ${PROJECT_NAME})..."
  bunx --bun wrangler pages deploy docs/.vitepress/dist --project-name "${PROJECT_NAME}" ${BRANCH_FLAG[@]:-}
else
  echo "Deploying to Cloudflare Workers (Assets)…"
  # Optionally override the worker name at deploy time
  NAME_FLAG=()
  if [[ -n "${CF_WORKER_NAME:-}" ]]; then
    NAME_FLAG=(--name "${CF_WORKER_NAME}")
  fi
  if [[ "${CF_PREVIEW:-0}" == "1" ]]; then
    bunx --bun wrangler deploy --config docs/wrangler.toml --dry-run --outdir /tmp ${NAME_FLAG[@]:-}
    echo "Preview build created locally (no publish)."
  else
    bunx --bun wrangler deploy --config docs/wrangler.toml ${NAME_FLAG[@]:-}
  fi
  echo "Workers deploy complete. Configure routes or custom domains in Cloudflare dashboard as needed."
fi

echo "Done."
