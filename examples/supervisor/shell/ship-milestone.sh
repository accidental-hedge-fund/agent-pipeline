#!/usr/bin/env bash
# Thin host adapter for the Pipeline-owned ship coordinator.
#
#   ship-milestone.sh --milestone v1.34.0 --for 1.34.0 \
#     --authorization /absolute/path/to/authorization.json
#   ship-milestone.sh --milestone v1.34.0 --for 1.34.0 \
#     --authorization /absolute/path/to/authorization.json --detach
#   ship-milestone.sh --milestone v1.34.0 --for 1.34.0 --status
#
# The adapter does not implement train, recovery, FRG, release, promotion,
# retry, or event-discovery logic. Pipeline owns those decisions. systemd owns
# detached process supervision.
set -euo pipefail

PIPELINE="${PIPELINE:-pipeline}"
REPO_DIR="${REPO_DIR:-}"
ALLOW_MERGE="${ALLOW_MERGE:-0}"
SYSTEMD_RUN="${SYSTEMD_RUN:-systemd-run}"

milestone=""
version=""
authorization=""
do_status=0
do_detach=0

usage() {
  cat <<'USAGE'
Usage:
  ship-milestone.sh --milestone <milestone> --for <X.Y.Z> \
    --authorization <absolute-json> [--detach]
  ship-milestone.sh --milestone <milestone> --for <X.Y.Z> --status

For a version-named milestone, --for defaults to the milestone without its
leading "v". A ship request requires REPO_DIR, ALLOW_MERGE=1, and an absolute
authorization path. --detach submits one transient user-systemd unit and
returns after admission; Pipeline owns durable resume and idempotency.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --milestone|-m)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      milestone=$2
      shift 2
      ;;
    --for|--version)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      version=${2#v}
      shift 2
      ;;
    --authorization)
      [[ -n "${2:-}" ]] || { echo "missing value for $1" >&2; exit 2; }
      authorization=$2
      shift 2
      ;;
    --status)
      do_status=1
      shift
      ;;
    --detach)
      do_detach=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --milestones)
      echo "--milestones is not supported; submit one authorized Pipeline ship per milestone" >&2
      exit 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -n "$milestone" ]] || { echo "--milestone is required" >&2; exit 2; }
if [[ -z "$version" && "$milestone" == v* ]]; then
  version=${milestone#v}
fi
[[ -n "$version" ]] || { echo "--for is required when the milestone is not version-named" >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid release version: $version" >&2
  exit 2
}
[[ "$do_status" -eq 0 || "$do_detach" -eq 0 ]] || {
  echo "--status and --detach cannot be combined" >&2
  exit 2
}
[[ -n "$REPO_DIR" && -d "$REPO_DIR" ]] || {
  echo "REPO_DIR is required and must be a directory" >&2
  exit 2
}
REPO_DIR=$(cd "$REPO_DIR" && pwd -P)

if [[ "$do_status" -eq 1 ]]; then
  cd "$REPO_DIR"
  exec "$PIPELINE" ship status --milestone "$milestone" --for "$version" --json
fi

[[ "$ALLOW_MERGE" == "1" ]] || {
  echo "ALLOW_MERGE must be 1 for an authorized ship request" >&2
  exit 2
}
[[ -n "$authorization" ]] || { echo "--authorization is required" >&2; exit 2; }
[[ "$authorization" == /* ]] || { echo "--authorization must be an absolute path" >&2; exit 2; }
[[ -f "$authorization" ]] || { echo "authorization file not found: $authorization" >&2; exit 2; }

ship_args=(
  ship
  --milestone "$milestone"
  --for "$version"
  --authorization "$authorization"
  --json
)

if [[ "$do_detach" -eq 0 ]]; then
  cd "$REPO_DIR"
  exec "$PIPELINE" "${ship_args[@]}"
fi

command -v "$SYSTEMD_RUN" >/dev/null 2>&1 || {
  echo "systemd-run is required for --detach" >&2
  exit 2
}

# Keep the unit name stable and repo-scoped for same-request admission. The
# checksum bounds arbitrary path/milestone length; Pipeline holds the full
# collision-resistant coordinate key and rejects mismatched status.
read -r unit_hash _ < <(printf '%s\n%s\n%s\n' "$REPO_DIR" "$milestone" "$version" | cksum)
unit_label=$(printf '%s-%s' "$milestone" "$version" | tr -c 'A-Za-z0-9_.-' '-')
unit_label=${unit_label:0:80}
unit="pipeline-ship-${unit_label}-${unit_hash}"

exec "$SYSTEMD_RUN" \
  --user \
  --collect \
  --unit "$unit" \
  --property Restart=on-abnormal \
  --property RestartSec=5s \
  --property StartLimitIntervalSec=60s \
  --property StartLimitBurst=3 \
  --working-directory "$REPO_DIR" \
  "$PIPELINE" "${ship_args[@]}"
