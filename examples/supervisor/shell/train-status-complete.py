#!/usr/bin/env python3
"""Evaluate last train_status in a mixed prose+JSON train capture.

Used by pipeline-ship-playbook.sh for the train completion gate (and resume
prior-complete checks). `pipeline train --json` may emit human-readable prose
before the final train_status object; whole-stream json.load then fails even
when the train is truly complete.

Scan the stream with JSONDecoder.raw_decode, skip non-JSON spans, consider
objects inside arrays, and use the **last** object whose kind is train_status.
Success: complete is True and blocker is null/absent/falsey.
When a blocker is present, write <path>.blocker for operator diagnostics.

Usage:
  train-status-complete.py <capture-path>
  Prints 1 (complete) or 0 (incomplete/blocked/missing) on stdout.
  Exit code is always 0 unless the path is missing/unreadable (exit 2).
"""
from __future__ import annotations

import json
import os
import sys


def iter_json_values(raw: str):
    """Yield decoded JSON values, skipping non-JSON spans between them."""
    dec = json.JSONDecoder()
    i = 0
    n = len(raw)
    while i < n:
        while i < n and raw[i].isspace():
            i += 1
        if i >= n:
            break
        try:
            obj, j = dec.raw_decode(raw, i)
            yield obj
            i = j
        except Exception:
            brace = raw.find("{", i + 1)
            if brace < 0:
                break
            i = brace


def last_train_status(raw: str) -> dict | None:
    """Return the last train_status object in raw (or None)."""
    last = None
    for obj in iter_json_values(raw):
        seq = obj if isinstance(obj, list) else [obj]
        for item in seq:
            if isinstance(item, dict) and item.get("kind") == "train_status":
                last = item
    return last


def evaluate_capture(path: str, *, write_blocker: bool = True) -> tuple[bool, object]:
    """
    Evaluate train completeness from capture file at path.

    Returns (ok, blocker) where ok is True only when the last train_status has
    complete is True and no blocker. Writes path+'.blocker' when blocker is set
    and write_blocker is True.
    """
    complete = False
    blocker = None
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
        status = last_train_status(raw)
        if status is not None:
            complete = status.get("complete") is True
            blocker = status.get("blocker")
    except OSError:
        raise
    except Exception:
        complete = False
        blocker = None

    if write_blocker and blocker:
        with open(path + ".blocker", "w", encoding="utf-8") as f:
            f.write(str(blocker))

    ok = bool(complete and not blocker)
    return ok, blocker


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: train-status-complete.py <capture-path>", file=sys.stderr)
        return 2
    path = argv[1]
    if not os.path.exists(path):
        print("0")
        return 0
    try:
        ok, _ = evaluate_capture(path)
    except OSError as e:
        print(f"train-status-complete: {e}", file=sys.stderr)
        return 2
    print("1" if ok else "0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
