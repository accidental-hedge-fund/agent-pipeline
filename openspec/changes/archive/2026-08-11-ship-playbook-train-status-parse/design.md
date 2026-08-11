## Context

See proposal.md for the production failure (v1.35.0 ship false-fail at train completion).

Relevant current shapes:

1. **Ship playbook train phase** — `examples/supervisor/shell/pipeline-ship-playbook.sh` runs `pipeline train --milestone … --merge --json`, captures stdout to `$RUN_DIR/train.json`, then gates on completeness before release / wait / engine-promote.
2. **Broken complete-check** — the post-success gate used whole-stream `json.load` on `train.json`. Leading prose causes parse failure → prints `0` → playbook logs `train JSON not complete` and exits 1 even when the trailing `train_status` has `complete: true` and no blocker.
3. **Working resume-check** — when train exits non-zero, the same script already scans prior/current captures with `json.JSONDecoder().raw_decode`, skips non-JSON spans, and treats a found `train_status` with `complete: true` as resume success. The complete-check is inconsistent with that approach.
4. **Train emit contract** — living `integrated-train-mode` requires `--json` to emit one final `train_status` object parseable by a single `JSON.parse` of complete stdout, and nested singles suppress machine handoff on stdout when `opts.json` is set. Production captures can still include human-readable prose (engine version skew, residual logging, or mixed historical output). The playbook is a consumer and must not false-fail on that.

Related open implementation: PR #982 on `fix/ship-playbook-train-json-parse` applies the consumer-side `raw_decode` + last-`train_status` evaluation. This OpenSpec change captures the required behavior independent of that PR's exact diff.

## Goals / Non-Goals

**Goals:**

- Align the train **completion** gate with the resume-check's streaming decode so a mixed prose+JSON complete stream evaluates as complete.
- Keep fail-closed behavior for incomplete trains and non-null blockers, including blocker side-file capture.
- Keep pure-JSON complete streams working.
- Make the decode+evaluate rule easy to regression-test without a live train.

**Non-Goals:**

- Changing `pipeline train` merge/advance semantics or authorization.
- Replacing the shell playbook with `pipeline ship` (ship-coordinator remains a separate in-engine path).
- Softening incompleteness: a missing/`complete: false`/`blocker` present train still fails the gate.
- Broad refactor of the ship playbook (FRG generation, release, engine-promote phases stay as-is).
- Claiming that mixed stdout is the desired long-term train contract (pure JSON remains preferred per `integrated-train-mode`).

## Decisions

### D1 — Consumer-side trailing/`raw_decode` evaluation (not only fix train emit)

**Decision:** Fix the ship playbook gate to scan the captured stream for JSON values (via incremental `raw_decode` or equivalent), select the last object with `kind == "train_status"`, and evaluate `complete` / `blocker` on that object. Apply the same approach whether the stream is pure JSON, prose-prefixed, or contains intermediate JSON fragments.

**Why not only enforce pure train stdout?**  
Even if current core already aims for pure JSON, the playbook must supervise real host engines and historical captures. The resume path already chose defensive scanning. Matching that reduces dual-parser drift. Hardening only the producer leaves existing mixed `train.json` artifacts and older installs false-failing.

**Alternatives considered:**

| Approach | Reject reason / defer |
| --- | --- |
| `json.load` after stripping non-JSON prefix with a regex | Fragile; brittle on braces in prose |
| Parse only the last line / last `{…}` slice | Multi-line pretty-printed `train_status` (engine uses `JSON.stringify(..., null, 2)`) spans lines |
| Force train to write a separate `.json` file | Larger surface; playbook already captures stdout; out of issue scope |
| Switch operators to `pipeline ship` only | Different auth/grant model; playbook remains the chain-to-existing-tools path |

### D2 — Last `train_status` wins; arrays allowed

**Decision:** While scanning, when a decoded value is a list, walk its elements; when an element/object has `kind == "train_status"`, update the running `complete`/`blocker` from that object. After the full scan, success is `complete is True` and `blocker` is null/absent/falsey per existing gate semantics. If a blocker is present on the last such object, write `train.json.blocker` as today.

**Why last wins?**  
Matches chronological "final status" semantics and matches the old list-tail behavior (`d=d[-1]`). Intermediate status objects, if any, must not override the final one.

### D3 — Keep logic in the playbook shell/Python inline unless extraction is needed for tests

**Decision:** Prefer the minimal fix already proven in the resume-check and PR #982 (inline Python in the shell playbook). Extract a tiny pure function/script under `examples/supervisor/` or `core/` **only if** that is the cleanest path to a deterministic regression test in this repo's CI. Do not move the gate into the advance/loop state machine.

**Why:** Issue scope is surgical; the playbook is not under `core/`, so no plugin mirror is required for the primary fix. If tests cannot exercise the shell snippet without extraction, a small pure helper is acceptable design follow-through — not a new subsystem.

### D4 — Conflict with pure-JSON train contract is documented, not averaged

**Decision:** Do not weaken `integrated-train-mode`'s requirement that `--json` emit one final parseable `train_status`. Document that the playbook is **defense in depth** for mixed captures. If a later change wants to fail CI when train leaks prose, that is a separate producer-side change.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Over-accepting a non-final intermediate `train_status` with `complete: true` | Prefer **last** matching object; unit fixture with two statuses proves last wins |
| Silent success when no `train_status` is present | Missing status keeps `complete=False` → fail closed (print `0`) |
| Divergent resume-check vs complete-check parsers again | Reuse the same decode loop shape; tasks call out alignment |
| False confidence that train never emits prose | Keep pure-JSON preferred in train specs; playbook remains defensive |

## Migration Plan

- Ship the playbook script fix (and tests) via normal PR; operators who install from the repo copy/install the updated `pipeline-ship-playbook.sh`.
- No data migration. Existing failed ship run directories with mixed `train.json` become re-evaluable if re-run through the fixed gate or inspected with the same decode logic.
- Rollback: revert the playbook script; failure mode returns to false-fail on mixed streams (known).

## Open Questions

- None that block the specs or tasks. Optional later: whether `pipeline ship` status evaluation should share the same decoder helper for consistency (out of scope here).
