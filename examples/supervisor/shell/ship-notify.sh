#!/usr/bin/env bash
# Optional ship status notifier for thin supervisors.
# Posts to Buzz when configured; otherwise no-ops (exit 0).
# Best-effort: messenger failures are retried, audited, and marked, but the
# process still exits 0 so ship/train never block solely on channel delivery.
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
#   PIPELINE_SUPERVISOR_STATE state root for dedupe / audit / failure markers
#   SHIP_NOTIFY_DEDUP_TTL_S  dedupe window seconds (default 120)
#   SHIP_NOTIFY_MAX_ATTEMPTS total send attempts including the first (default 3)
#   SHIP_NOTIFY_BACKOFF_S    space-separated sleeps (seconds) after each failed
#                            attempt before the next try (default: "5 15 45").
#                            Use "0 0 0" (or fewer zeros) in tests to skip waits.
#   SHIP_NOTIFY_VERBOSE      1 to print send stderr to this process stderr
#
# State under $PIPELINE_SUPERVISOR_STATE/notify/ (or helper default state root):
#   <key_safe>              dedupe file: epoch<TAB>content (unchanged format)
#   audit.log               append-only terminal outcomes (ok / fail)
#   failed/<id>             supervisor-visible final-failure marker
#
# Without BUZZ_BIN + credentials + channel, this script exits 0 and does nothing
# (no invented failure markers for unconfigured messenger).
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
FAILED_DIR="$DEDUP_DIR/failed"
AUDIT_LOG="$DEDUP_DIR/audit.log"
DEDUP_TTL_S="${SHIP_NOTIFY_DEDUP_TTL_S:-120}"
MAX_ATTEMPTS="${SHIP_NOTIFY_MAX_ATTEMPTS:-3}"
BACKOFF_S="${SHIP_NOTIFY_BACKOFF_S:-5 15 45}"
VERBOSE="${SHIP_NOTIFY_VERBOSE:-0}"
# Best-effort notify directory: unusable state must not abort before send.
if ! mkdir -p "$DEDUP_DIR" 2>/dev/null; then
  printf 'ship-notify: notify state unavailable (%s); continuing without local persistence\n' \
    "$DEDUP_DIR" >&2 || true
fi

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

key_safe=""
if [[ -n "$key" ]]; then
  key_safe=$(printf '%s' "$key" | tr -c 'A-Za-z0-9._+@-' '_')
fi

if [[ -n "$key" && "$force" -eq 0 ]]; then
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
  # Best-effort dedupe write — skip if state is unusable.
  if ! printf '%s\t%s' "$now" "$content" >"$last" 2>/dev/null; then
    printf 'ship-notify: dedupe write failed (%s); continuing\n' "$last" >&2 || true
  fi
elif [[ -n "$key" ]]; then
  if ! printf '%s\t%s' "$(date +%s)" "$content" >"$DEDUP_DIR/$key_safe" 2>/dev/null; then
    printf 'ship-notify: dedupe write failed (%s); continuing\n' "$DEDUP_DIR/$key_safe" >&2 || true
  fi
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

notify_args=(messages send --channel "$BUZZ_CHANNEL" --content "$msg")
[[ -z "$BUZZ_REPLY_TO" ]] || notify_args+=(--reply-to "$BUZZ_REPLY_TO")

# Parse backoff schedule into an array (defaults tolerate short schedules).
read -r -a backoff_arr <<<"$BACKOFF_S"

truncate_reason() {
  local s=$1
  # Collapse whitespace; cap length for audit/marker durability.
  s=$(printf '%s' "$s" | tr '\n\r' '  ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  if [[ ${#s} -gt 500 ]]; then
    s="${s:0:497}..."
  fi
  printf '%s' "$s"
}

append_audit() {
  # Best-effort: filesystem failures must not make the helper exit non-zero.
  local status=$1 attempts=$2 reason=$3
  local ts key_field
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u +%s)
  key_field="${key:-}"
  if ! mkdir -p "$DEDUP_DIR" 2>/dev/null; then
    printf 'ship-notify: audit write failed (mkdir %s); status=%s reason=%s\n' \
      "$DEDUP_DIR" "$status" "$reason" >&2 || true
    return 0
  fi
  # Fields: ts status attempts key reason  (tab-separated; reason last)
  if ! printf '%s\t%s\tattempts=%s\tkey=%s\t%s\n' \
    "$ts" "$status" "$attempts" "$key_field" "$reason" >>"$AUDIT_LOG" 2>/dev/null; then
    printf 'ship-notify: audit write failed (%s); status=%s reason=%s\n' \
      "$AUDIT_LOG" "$status" "$reason" >&2 || true
    return 0
  fi
  return 0
}

clear_key_failure_markers() {
  [[ -n "$key_safe" ]] || return 0
  [[ -d "$FAILED_DIR" ]] || return 0
  # Key-scoped markers: failed/<key_safe>-*
  local f
  for f in "$FAILED_DIR"/"$key_safe"-*; do
    [[ -e "$f" ]] || continue
    rm -f "$f" || true
  done
  return 0
}

write_failure_marker() {
  # Best-effort: marker persistence failures must not make the helper exit non-zero.
  local attempts=$1 reason=$2
  local epoch marker id
  epoch=$(date +%s)
  if ! mkdir -p "$FAILED_DIR" 2>/dev/null; then
    printf 'ship-notify: failure marker write failed (mkdir %s); attempts=%s reason=%s\n' \
      "$FAILED_DIR" "$attempts" "$reason" >&2 || true
    return 0
  fi
  if [[ -n "$key_safe" ]]; then
    id="${key_safe}-${epoch}"
  else
    id="anon-${epoch}"
  fi
  marker="$FAILED_DIR/$id"
  if ! {
    printf 'status=fail\n'
    printf 'epoch=%s\n' "$epoch"
    printf 'attempts=%s\n' "$attempts"
    printf 'key=%s\n' "${key:-}"
    printf 'content=%s\n' "$content"
    printf 'reason=%s\n' "$reason"
  } >"$marker" 2>/dev/null; then
    printf 'ship-notify: failure marker write failed (%s); attempts=%s reason=%s\n' \
      "$marker" "$attempts" "$reason" >&2 || true
    return 0
  fi
  return 0
}

if ! [[ "$MAX_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  MAX_ATTEMPTS=3
fi

attempt=0
last_reason=""
last_status=1
send_ok=0

while [[ $attempt -lt $MAX_ATTEMPTS ]]; do
  attempt=$((attempt + 1))
  set +e
  # Capture stderr (and stdout) so failures are not silent; do not spam callers
  # unless SHIP_NOTIFY_VERBOSE=1.
  send_out=$("$BUZZ_BIN" "${notify_args[@]}" 2>&1)
  last_status=$?
  set -e
  if [[ "$VERBOSE" == "1" && -n "$send_out" ]]; then
    printf '%s\n' "$send_out" >&2 || true
  fi
  if [[ $last_status -eq 0 ]]; then
    send_ok=1
    break
  fi
  last_reason=$(truncate_reason "${send_out:-exit $last_status}")
  if [[ -z "$last_reason" ]]; then
    last_reason="exit $last_status"
  fi
  # Sleep before next attempt when budget remains.
  if [[ $attempt -lt $MAX_ATTEMPTS ]]; then
    sleep_idx=$((attempt - 1))
    sleep_s=0
    if [[ ${#backoff_arr[@]} -gt 0 ]]; then
      if [[ $sleep_idx -lt ${#backoff_arr[@]} ]]; then
        sleep_s=${backoff_arr[$sleep_idx]}
      else
        last_i=$((${#backoff_arr[@]} - 1))
        sleep_s=${backoff_arr[$last_i]}
      fi
    fi
    if [[ "$sleep_s" =~ ^[0-9]+$ ]] && [[ "$sleep_s" -gt 0 ]]; then
      sleep "$sleep_s"
    fi
  fi
done

if [[ $send_ok -eq 1 ]]; then
  append_audit "ok" "$attempt" "delivered"
  clear_key_failure_markers
  exit 0
fi

# Final failure: durable audit + supervisor-visible marker; still exit 0.
if [[ -z "$last_reason" ]]; then
  last_reason="exit ${last_status:-1}"
fi
append_audit "fail" "$attempt" "$last_reason"
write_failure_marker "$attempt" "$last_reason"
exit 0
