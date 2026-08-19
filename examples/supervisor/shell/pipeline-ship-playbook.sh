#!/usr/bin/env bash
# pipeline-ship-playbook — thin launcher to repo Tugboat (#1151).
#
# Install (keep in sync with the candidate tree):
#   install -m 0755 "$ROOT/examples/supervisor/shell/pipeline-ship-playbook.sh" \
#     "$HOME/.local/bin/pipeline-ship-playbook"
#
# This file must not retain a second ship-end compose. Train, FRG pack,
# release, finish, and promote live in:
#   $REPO_DIR/examples/supervisor/shell/tugboat.sh
# After train-complete, Tugboat invokes factory-release prepare, factory-gate,
# pipeline release, and release finish on the candidate engine. Train and
# engine-promote stay on process-start $PIPELINE. Tugboat does not invoke
# git tag or gh release create.
#
# REPO_DIR must already be set (existing playbook contract).
set -euo pipefail

if [[ -z "${REPO_DIR:-}" ]]; then
  echo "FAIL: REPO_DIR is required so the playbook can exec repo Tugboat" >&2
  exit 1
fi

if [[ ! -f "$REPO_DIR/examples/supervisor/shell/tugboat.sh" ]]; then
  echo "FAIL: missing $REPO_DIR/examples/supervisor/shell/tugboat.sh" >&2
  exit 1
fi

exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"
