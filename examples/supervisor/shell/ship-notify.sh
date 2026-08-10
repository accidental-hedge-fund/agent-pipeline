#!/usr/bin/env bash
# Optional ship status notifier for thin supervisors.
# Posts to Buzz when configured; otherwise no-ops (exit 0).
#
# Usage: ship-notify.sh "<message>" [dedupe-key] [--force]
#
# Environment:
#   SHIP_NOTIFY              0 to disable (default 1)
#   BUZZ_BIN                 path to buzz CLI (required to post)
#   BUZZ_RELAY_URL           relay URL
#   BUZZ_CHANNEL             channel id
#   BUZZ_REPLY_TO            authenticated event id for exact thread routing
#   BUZZ_CREDENTIALS_FILE    JSON with nsec (never commit real credentials)
#   PIPELINE_SUPERVISOR_STATE state root for dedupe files
#   SHIP_NOTIFY_DEDUP_TTL_S  dedupe window seconds (default 120)
#
# Without BUZZ_BIN + credentials + channel, this script exits 0 and does nothing.
set -euo pipefail

SHIP_NOTIFY="${SHIP_NOTIFY:-1}"
[[ "$SHIP_NOTIFY" == "1" ]] || exit 0

BUZZ_BIN="${BUZZ_BIN:-}"
BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-}"
BUZZ_CHANNEL="${BUZZ_CHANNEL:-}"
BUZZ_REPLY_TO="${BUZZ_REPLY_TO:-}"
BUZZ_CREDENTIALS_FILE="${BUZZ_CREDENTIALS_FILE:-}"
STATE_ROOT="${PIPELINE_SUPERVISOR_STATE:-$HOME/.local/state/pipeline-supervisor}"
DEDUP_DIR="$STATE_ROOT/notify"
DEDUP_TTL_S="${SHIP_NOTIFY_DEDUP_TTL_S:-120}"
mkdir -p "$DEDUP_DIR"

force=0
args=()
for a in "$@"; do
  if [[ "$a" == "--force" ]]; then force=1; else args+=("$a"); fi
done
set -- "${args[@]}"

content=${1:-}
key=${2:-}
[[ -n "$content" ]] || exit 0

content=$(printf '%s' "$content" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
[[ ${#content} -gt 900 ]] && content="${content:0:897}..."

if [[ -n "$key" && "$force" -eq 0 ]]; then
  key_safe=$(printf '%s' "$key" | tr -c 'A-Za-z0-9._+@-' '_')
  last="$DEDUP_DIR/$key_safe"
  now=$(date +%s)
  if [[ -f "$last" ]]; then
    prev=$(cat "$last" 2>/dev/null || true)
    prev_epoch=${prev%%$'\t'*}
    prev_msg=${prev#*$'\t'}
    if [[ "$prev_msg" == "$content" && "$prev_epoch" =~ ^[0-9]+$ ]]; then
      age=$((now - prev_epoch))
      [[ $age -lt $DEDUP_TTL_S ]] && exit 0
    fi
  fi
  printf '%s\t%s' "$now" "$content" >"$last"
elif [[ -n "$key" ]]; then
  key_safe=$(printf '%s' "$key" | tr -c 'A-Za-z0-9._+@-' '_')
  printf '%s\t%s' "$(date +%s)" "$content" >"$DEDUP_DIR/$key_safe"
fi

# No-op when messenger is not configured (safe default for CI / local use)
if [[ -z "$BUZZ_BIN" || ! -x "$BUZZ_BIN" ]]; then
  exit 0
fi
if [[ -z "$BUZZ_CHANNEL" || -z "$BUZZ_CREDENTIALS_FILE" || ! -f "$BUZZ_CREDENTIALS_FILE" ]]; then
  exit 0
fi

export BUZZ_RELAY_URL
export BUZZ_PRIVATE_KEY
BUZZ_PRIVATE_KEY=$(python3 -c "import json; print(json.load(open('$BUZZ_CREDENTIALS_FILE'))['nsec'])")
msg="🚢 $content"
set +e
notify_args=(messages send --channel "$BUZZ_CHANNEL" --content "$msg")
[[ -z "$BUZZ_REPLY_TO" ]] || notify_args+=(--reply-to "$BUZZ_REPLY_TO")
"$BUZZ_BIN" "${notify_args[@]}" >/dev/null 2>&1 || true
exit 0
