#!/usr/bin/env python3
"""Shared ship-release check waiter (#1110).

Reads a `gh pr checks --json name,state,bucket,link` capture from a file path
and prints a single numeric token on stdout:

  1   green   — all observable checks pass/skip (or none reported)
  0   pending — any check is pending / queued / in progress (whole-set first)
  2   rerun   — flake-eligible settled fail, rerun budget remains, run id present
  -1  fail    — terminal (non-test product fail, mixed fail, budget spent,
                or no workflow run id)

Existing 1 / 0 / -1 meanings stay stable. 2 is the distinct rerun token.

On rerun or fail, optionally writes a structured sidecar JSON (PR, check name,
bucket/state, link, run id, last failed test title when a failed-log is given).

Used by Tugboat and the ship playbook between opening the release PR and
`pipeline release finish`. Classification is deterministic from check metadata.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone


TOKEN_GREEN = 1
TOKEN_PENDING = 0
TOKEN_RERUN = 2
TOKEN_FAIL = -1

DEFAULT_ALLOWLIST = ("test",)
DEFAULT_BUDGET = 1
MAX_BUDGET = 2

PENDING_STATES = {
    "PENDING",
    "IN_PROGRESS",
    "QUEUED",
    "WAITING",
    "REQUESTED",
}
PENDING_BUCKETS = {"PENDING"}
FAIL_STATES = {"FAILURE", "ERROR", "CANCELLED"}
FAIL_BUCKETS = {"FAIL", "FAILURE", "ERROR", "CANCEL", "CANCELLED"}
PASS_BUCKETS = {"SUCCESS", "NEUTRAL", "SKIPPED", "EMPTY", "PASS", "SKIPPING", "SKIP", ""}

RUN_ID_RE = re.compile(r"/actions/runs/(\d+)")
FAIL_TITLE_RE = re.compile(r"^[✖×]\s+(.+)$")


def clamp_budget(raw) -> int:
    try:
        n = int(raw)
    except (TypeError, ValueError):
        n = DEFAULT_BUDGET
    if n < 1:
        return DEFAULT_BUDGET
    if n > MAX_BUDGET:
        return MAX_BUDGET
    return n


def parse_allowlist(raw) -> tuple[str, ...]:
    if raw is None or raw == "":
        return DEFAULT_ALLOWLIST
    names = tuple(p.strip() for p in str(raw).split(",") if p.strip())
    return names or DEFAULT_ALLOWLIST


def extract_run_id(link) -> str | None:
    if not link:
        return None
    m = RUN_ID_RE.search(str(link))
    return m.group(1) if m else None


def extract_failed_test_title(text: str) -> str | None:
    if not text:
        return None
    for line in text.splitlines():
        s = line.strip()
        m = FAIL_TITLE_RE.match(s)
        if m:
            title = m.group(1).strip()
            return title or None
    return None


def state_of(check: dict) -> str:
    return (check.get("state") or "").upper()


def bucket_of(check: dict) -> str:
    return (check.get("bucket") or check.get("conclusion") or "").upper()


def is_pending(check: dict) -> bool:
    st = state_of(check)
    bucket = bucket_of(check)
    if st in PENDING_STATES or bucket in PENDING_BUCKETS:
        return True
    if st in FAIL_STATES or bucket in FAIL_BUCKETS:
        return False
    if bucket and bucket not in PASS_BUCKETS:
        return True
    return False


def is_fail(check: dict) -> bool:
    return state_of(check) in FAIL_STATES or bucket_of(check) in FAIL_BUCKETS


def is_flake_eligible(name: str, allowlist: tuple[str, ...]) -> bool:
    return (name or "") in allowlist


def format_reason(
    pr,
    name: str,
    bucket: str,
    link: str,
    title: str | None = None,
    note: str | None = None,
) -> str:
    parts = []
    if pr not in (None, ""):
        parts.append(f"PR #{pr}")
    parts.append(f"check {name or '?'}")
    parts.append(bucket or "fail")
    if link:
        parts.append(link)
    reason = " ".join(parts)
    if title:
        reason = f"{reason} — {title}"
    if note:
        reason = f"{reason} ({note})"
    return reason


def pick_failed_check(fails: list[dict], allowlist: tuple[str, ...]) -> dict:
    for c in fails:
        if not is_flake_eligible(c.get("name") or "", allowlist):
            return c
    return fails[0]


def build_sidecar(
    *,
    outcome: str,
    pr,
    check: dict,
    title: str | None,
    note: str | None,
) -> dict:
    name = check.get("name") or ""
    bucket = (check.get("bucket") or check.get("conclusion") or "fail") or "fail"
    state = check.get("state") or ""
    link = check.get("link") or ""
    run_id = extract_run_id(link)
    desc = check.get("description") or ""
    if not title and desc:
        title = extract_failed_test_title(desc) or None
    reason = format_reason(pr, name, str(bucket), str(link), title, note)
    return {
        "pr": str(pr) if pr not in (None, "") else "",
        "outcome": outcome,
        "check_name": name,
        "bucket": bucket,
        "state": state,
        "link": link,
        "run_id": run_id or "",
        "failed_test_title": title or "",
        "reason": reason,
    }


def load_budget_doc(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
        if isinstance(doc, dict):
            return doc
    except Exception:
        pass
    return {"schema_version": 1, "entries": []}


def attempts_for(doc: dict, pr: str, head_sha: str) -> list:
    for entry in doc.get("entries") or []:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("pr") or "") == str(pr) and str(entry.get("head_sha") or "") == str(
            head_sha
        ):
            attempts = entry.get("attempts") or []
            return attempts if isinstance(attempts, list) else []
    return []


def budget_remaining(path: str | None, pr, head_sha, budget: int) -> int:
    if not path:
        return budget
    if pr in (None, "") or not head_sha:
        # Cannot key a durable attempt — fail closed (do not rerun).
        return 0
    doc = load_budget_doc(path)
    used = len(attempts_for(doc, str(pr), str(head_sha)))
    return max(0, budget - used)


def record_attempt(path: str, pr: str, head_sha: str, run_id: str) -> None:
    if not path:
        raise ValueError("budget file path required")
    if not pr or not head_sha or not run_id:
        raise ValueError("pr, head_sha, and run_id are required to record a rerun")
    doc = load_budget_doc(path)
    entries = doc.get("entries")
    if not isinstance(entries, list):
        entries = []
        doc["entries"] = entries
    doc["schema_version"] = 1
    entry = None
    for e in entries:
        if isinstance(e, dict) and str(e.get("pr") or "") == pr and str(e.get("head_sha") or "") == head_sha:
            entry = e
            break
    if entry is None:
        entry = {"pr": pr, "head_sha": head_sha, "attempts": []}
        entries.append(entry)
    attempts = entry.get("attempts")
    if not isinstance(attempts, list):
        attempts = []
        entry["attempts"] = attempts
    attempts.append(
        {
            "run_id": run_id,
            "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
    )
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)
        fh.write("\n")


def classify(checks, opts=None):
    """Return (token, sidecar_or_none)."""
    opts = opts or {}
    allowlist = opts.get("allowlist") or DEFAULT_ALLOWLIST
    budget = clamp_budget(opts.get("budget", DEFAULT_BUDGET))
    remaining = opts.get("remaining")
    if remaining is None:
        remaining = budget_remaining(
            opts.get("budget_file"),
            opts.get("pr"),
            opts.get("head_sha"),
            budget,
        )
    title = opts.get("failed_title")
    pr = opts.get("pr")

    if not checks:
        return TOKEN_GREEN, None

    pending = False
    fails = []
    for c in checks:
        if is_pending(c):
            pending = True
        if is_fail(c):
            fails.append(c)

    if pending:
        return TOKEN_PENDING, None
    if not fails:
        return TOKEN_GREEN, None

    chosen = pick_failed_check(fails, allowlist)
    all_flake = all(is_flake_eligible(c.get("name") or "", allowlist) for c in fails)
    run_ids = [extract_run_id(c.get("link")) for c in fails]
    has_run_id = any(run_ids)

    if not all_flake:
        note = "non-flake product fail" if len(fails) == 1 else "mixed flake and product fail"
        return TOKEN_FAIL, build_sidecar(
            outcome="fail", pr=pr, check=chosen, title=title, note=note
        )
    if not has_run_id:
        return TOKEN_FAIL, build_sidecar(
            outcome="fail",
            pr=pr,
            check=chosen,
            title=title,
            note="no workflow run id",
        )
    if remaining <= 0:
        return TOKEN_FAIL, build_sidecar(
            outcome="fail",
            pr=pr,
            check=chosen,
            title=title,
            note="rerun budget spent",
        )
    return TOKEN_RERUN, build_sidecar(
        outcome="rerun", pr=pr, check=chosen, title=title, note=None
    )


def write_sidecar(path: str | None, sidecar: dict | None) -> None:
    if not path or sidecar is None:
        return
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(sidecar, fh, indent=2)
        fh.write("\n")


def parse_argv(argv):
    args = {
        "checks_path": None,
        "sidecar": None,
        "pr": None,
        "head_sha": None,
        "budget": DEFAULT_BUDGET,
        "budget_file": None,
        "allowlist": DEFAULT_ALLOWLIST,
        "failed_log": None,
        "record_attempt": False,
        "run_id": None,
        "format_detail": None,
    }
    i = 0
    while i < len(argv):
        a = argv[i]
        if a == "--record-attempt":
            args["record_attempt"] = True
        elif a == "--format-detail":
            i += 1
            args["format_detail"] = argv[i] if i < len(argv) else None
        elif a == "--sidecar":
            i += 1
            args["sidecar"] = argv[i] if i < len(argv) else None
        elif a == "--pr":
            i += 1
            args["pr"] = argv[i] if i < len(argv) else None
        elif a == "--head-sha":
            i += 1
            args["head_sha"] = argv[i] if i < len(argv) else None
        elif a == "--budget":
            i += 1
            args["budget"] = clamp_budget(argv[i] if i < len(argv) else DEFAULT_BUDGET)
        elif a == "--budget-file":
            i += 1
            args["budget_file"] = argv[i] if i < len(argv) else None
        elif a == "--allowlist":
            i += 1
            args["allowlist"] = parse_allowlist(argv[i] if i < len(argv) else "")
        elif a == "--failed-log":
            i += 1
            args["failed_log"] = argv[i] if i < len(argv) else None
        elif a == "--run-id":
            i += 1
            args["run_id"] = argv[i] if i < len(argv) else None
        elif a.startswith("-"):
            print(f"unknown option: {a}", file=sys.stderr)
            return None
        elif args["checks_path"] is None:
            args["checks_path"] = a
        i += 1
    return args


def main(argv):
    args = parse_argv(argv)
    if args is None:
        print(str(TOKEN_PENDING))
        return 0

    if args["format_detail"]:
        try:
            with open(args["format_detail"], "r", encoding="utf-8") as fh:
                doc = json.load(fh)
            reason = (doc.get("reason") or "").strip()
            if reason:
                print(reason[:400])
        except Exception:
            pass
        return 0

    if args["record_attempt"]:
        try:
            record_attempt(
                args["budget_file"] or "",
                str(args["pr"] or ""),
                str(args["head_sha"] or ""),
                str(args["run_id"] or ""),
            )
        except Exception as exc:
            print(f"record-attempt failed: {exc}", file=sys.stderr)
            return 1
        return 0

    if not args["checks_path"]:
        print(str(TOKEN_PENDING))
        return 0
    try:
        with open(args["checks_path"], "r", encoding="utf-8") as fh:
            checks = json.load(fh)
    except Exception:
        # Unparseable capture is not evidence of green — keep waiting.
        print(str(TOKEN_PENDING))
        return 0

    title = None
    if args["failed_log"]:
        try:
            with open(args["failed_log"], "r", encoding="utf-8", errors="replace") as fh:
                title = extract_failed_test_title(fh.read(200_000))
        except Exception:
            title = None

    token, sidecar = classify(
        checks,
        {
            "allowlist": args["allowlist"],
            "budget": args["budget"],
            "budget_file": args["budget_file"],
            "pr": args["pr"],
            "head_sha": args["head_sha"],
            "failed_title": title,
        },
    )
    write_sidecar(args["sidecar"], sidecar)
    print(token)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
