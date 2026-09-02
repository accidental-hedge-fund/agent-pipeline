#!/usr/bin/env bash
# Thin launcher for the installed agent-pipeline CLI.
# Prefer setting PIPELINE in your supervisor env; this script is for hosts that
# want a stable PATH entry without hardcoding install locations in other scripts.
#
# Resolution order:
#   1. PIPELINE env (if set and executable / invokable)
#   2. `pipeline` on PATH
#   3. node + common skill install paths (codex / claude)
#
# Usage: pipeline-launcher.sh <pipeline-args...>
#        PIPELINE_LAUNCHER_PRINT=1 pipeline-launcher.sh   # print resolved command only
#
# #971 request/receipt/follow baseline: this wrapper execs the pipeline CLI.
# Dead-worker restore is `pipeline liveness restore`. Follow is `pipeline logs`
# / `pipeline loop logs`. This launcher is not the lifecycle owner and must
# not retry a supervised verb or classify recovery.
set -euo pipefail

resolve() {
  if [[ -n "${PIPELINE:-}" ]]; then
    # Allow "node /path/to/pipeline.mjs" style by using eval only when multi-word
    echo "$PIPELINE"
    return 0
  fi
  if command -v pipeline >/dev/null 2>&1; then
    command -v pipeline
    return 0
  fi
  local candidates=(
    "$HOME/.codex/skills/pipeline/scripts/pipeline.mjs"
    "$HOME/.claude/skills/pipeline/scripts/pipeline.mjs"
    "$HOME/.local/share/agent-pipeline/pipeline.mjs"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -f "$c" ]]; then
      echo "node $c"
      return 0
    fi
  done
  echo "pipeline-launcher: could not resolve pipeline binary; set PIPELINE" >&2
  return 1
}

resolved=$(resolve) || exit 2

# Factory control plane (#1127): export the factory pin when unset so
# engine-promote and the next train doctor share one path. Do not overwrite
# an operator value. Do not invent a pin for an ordinary product repo.
if [[ -z "${AGENT_PIPELINE_PRODUCTION_PIN:-}" ]]; then
  if [[ -n "${AGENT_PIPELINE_FACTORY_CONTROL:-}" ]]; then
    export AGENT_PIPELINE_PRODUCTION_PIN="$AGENT_PIPELINE_FACTORY_CONTROL/.agent-pipeline/production-engine-pin.json"
  elif [[ -n "${REPO_DIR:-}" ]]; then
    export AGENT_PIPELINE_PRODUCTION_PIN="$REPO_DIR/.agent-pipeline/production-engine-pin.json"
  fi
fi

if [[ "${PIPELINE_LAUNCHER_PRINT:-0}" == "1" ]]; then
  printf '%s\n' "$resolved"
  exit 0
fi

# shellcheck disable=SC2086
exec $resolved "$@"
