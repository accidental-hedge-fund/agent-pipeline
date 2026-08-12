#!/usr/bin/env python3
"""Pure helper: decide whether a release PR's observable checks are green.

Reads a `gh pr checks --json name,state,conclusion` capture from a file path
and prints a single token on stdout:

  1   all observable checks are green (or none reported) — safe to release-finish
  0   still waiting (a check is pending / queued / in progress / awaiting)
  -1  hard failure (a check failed / errored / cancelled) — abort, don't wait

Used by the ship playbook between opening the release PR and `release finish`.
`pipeline release finish` refuses to merge while observable checks are
pending/failing, so the playbook must wait for green rather than race the
just-opened PR's CI (#...).
"""
import json
import sys


def classify(checks):
    """Return 1 (green), 0 (waiting), or -1 (failed)."""
    if not checks:
        # No observable checks reported — nothing to wait on; treat as green.
        return 1
    for c in checks:
        st = (c.get("state") or "").upper()
        # `state` is the GitHub check state (SUCCESS/FAILURE/PENDING/QUEUED/etc).
        # `bucket` is gh's human bucket ("pass"/"fail"/"pending"/"error"/etc).
        con = (c.get("bucket") or c.get("conclusion") or "").upper()
        if st in ("PENDING", "IN_PROGRESS", "QUEUED", "WAITING", "REQUESTED"):
            return 0
        if st in ("FAILURE", "ERROR", "CANCELLED") or con in (
            "FAILURE",
            "CANCELLED",
            "FAIL",
            "ERROR",
        ):
            return -1
        if con and con not in (
            "SUCCESS",
            "NEUTRAL",
            "SKIPPED",
            "EMPTY",
            "PASS",
            "",
        ):
            return 0
    return 1


def main(argv):
    if len(argv) < 1:
        print("0")
        return 0
    try:
        with open(argv[0], "r", encoding="utf-8") as fh:
            checks = json.load(fh)
    except Exception:
        # Unparseable capture is not evidence of green — keep waiting.
        print("0")
        return 0
    print(classify(checks))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
