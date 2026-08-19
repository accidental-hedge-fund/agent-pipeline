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
# After train-complete, Tugboat invokes FRG pack, factory-gate, release,
# and release finish on the candidate engine. Train and engine-promote stay
# on process-start $PIPELINE. Tugboat does not invoke git tag or gh release create.
#
# REPO_DIR must already be set (existing playbook contract).
exec "$REPO_DIR/examples/supervisor/shell/tugboat.sh" "$@"
