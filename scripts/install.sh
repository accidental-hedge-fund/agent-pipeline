#!/usr/bin/env bash
# Convenience wrapper: clone (or update) the repo to a cache dir and run the
# installer. The repo is public, so no special access is required.
#
#   curl -fsSL https://raw.githubusercontent.com/accidental-hedge-fund/agent-pipeline/main/scripts/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --host codex
#
# Or just clone and run directly:
#   gh repo clone accidental-hedge-fund/agent-pipeline && node agent-pipeline/scripts/install.mjs install
set -euo pipefail

REPO="${AGENT_PIPELINE_REPO:-accidental-hedge-fund/agent-pipeline}"
REF="${AGENT_PIPELINE_REF:-main}"
CACHE="${AGENT_PIPELINE_CACHE:-$HOME/.cache/agent-pipeline}"

for bin in git node; do
  command -v "$bin" >/dev/null 2>&1 || { echo "✗ '$bin' is required on PATH." >&2; exit 1; }
done

if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" fetch --depth 1 origin "$REF" >/dev/null 2>&1
  git -C "$CACHE" checkout -q FETCH_HEAD
else
  rm -rf "$CACHE"
  git clone --depth 1 --branch "$REF" "git@github.com:${REPO}.git" "$CACHE" 2>/dev/null \
    || git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$CACHE"
fi

exec node "$CACHE/scripts/install.mjs" install "$@"
