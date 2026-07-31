## Why

The installable factory skill's **single-issue advance orchestration** (§4) starts a
detached run and tells the host to follow `events.jsonl` until `run_complete`, but it
does **not** make recovery after a cancelled, timed-out, or lost follow **mandatory or
machine-checkable**. Compliant-looking agents then stop supervising while the engine
continues in the background, and never re-attach or post the terminal summary — even
when the run reaches `pipeline:ready-to-deploy` with exit 0. Other machines only get
what ships in skill/engine text; ad-hoc operator lessons do not travel. Observed on a
Grok-hosted `/pipeline 712` advance: long event-wait cancelled mid review-2; the
detached run finished (PR #724); the host only reported terminal state after a human
asked “is this done?” That is a **factory reliability** defect: work completed without
operator handoff under normal host interrupt conditions.

## What Changes

- **Host skill orchestration (packaging).** Strengthen §4 (Claude, Codex, and any
  mirrored command/skill packaging that restates default advance orchestration) so that
  if a follow/wait is cancelled, interrupted, times out without re-arm, or the host
  session loses the wait **before** `run_complete` / sentinel completion, the host
  **must same-turn**:
  1. check run liveness (`status`, sentinel, or process),
  2. re-arm `pipeline logs <run-id> --events --follow` (or equivalent),
  3. continue until terminal,
  4. then emit the final summary and stop follows.
- **Contract clarity.** State explicitly that a cancelled wait is **not** a terminal
  pipeline outcome and must not be treated as “stop watching.”
- **Operator re-attach path.** Document a one-line recovery path using **run-store**
  ids (`pipeline status N` + `pipeline logs <run-id> --events --follow` +
  `pipeline summary <run-id>`), not informal `/tmp` logs.
- **Drift guard.** Add a CI/host-skill regression check that fails if high-traffic
  orchestration text drops re-attach / “cancelled wait ≠ terminal” language (same
  spirit as loop-skill stop-on-terminal guards).
- **CLI follow (preferred).** Align advance `pipeline logs <run-id> --events --follow`
  with the loop-logs until-terminal pattern: exit 0 on `run_complete` by default, with
  an explicit interrupt-only opt-out (`--no-until-terminal`), so hosts can wait on
  process exit instead of re-implementing follow logic. Optionally surface a documented
  **supervise-until-terminal** one-liner / thin wrapper that prints summary after
  follow completes.
- **Docs / mirror.** Update host skills, command one-liners, and README notes; regenerate
  `plugin/` when packaging sources change.

## Acceptance criteria

- [ ] Host skill §4 (Claude and Codex) requires that a cancelled, interrupted, or
      timed-out follow **before** `run_complete` / sentinel completion triggers
      **same-turn** liveness check + re-arm of events follow + continue until terminal
      + final summary (not silent stop).
- [ ] Host skill text states that a cancelled wait is **not** a terminal pipeline
      outcome and must not be treated as “stop watching.”
- [ ] Installable surfaces document a concrete **re-attach** path:
      `pipeline status N` + `pipeline logs <run-id> --events --follow` +
      `pipeline summary <run-id>` using real run-store ids (not `/tmp` scratch logs).
- [ ] After a successful terminal follow, the host still emits the final summary
      (start stage → end stage, PR if any, wall clock, merge next step) and stops
      follows in the same turn.
- [ ] A packaging/skill drift-guard fails CI if re-attach / “cancelled wait ≠ terminal”
      language is removed or weakened from high-traffic §4 orchestration text.
- [ ] Preferred: `pipeline logs <run-id> --events --follow` exits 0 when a
      `run_complete` event is observed (until-terminal default), with an explicit
      interrupt-only opt-out; help and one-liners document that default.
- [ ] Preferred: a documented non-interactive supervise pattern (CLI or composed
      one-liner) that waits until terminal and surfaces `pipeline summary <run-id>`.
- [ ] Regression tests prove until-terminal exit on `run_complete` (when CLI change
      ships) and that the drift-guard bites when re-attach language is stripped.
- [ ] No change to advance-loop stage semantics, review policy, or merge behavior
      (pipeline still never merges).
- [ ] `npm run ci` is green (core tests, mirror check when packaging changes, install
      smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `advance-skill-orchestration`: Installable host skill contract for **single-issue**
  default advance: detach + event follow until terminal, mandatory re-attach after
  cancelled/lost wait, cancelled-wait ≠ terminal, operator re-attach path, terminal
  summary + same-turn follow teardown, and a drift-guard on that language.

### Modified Capabilities

- `log-follow-command`: Advance `pipeline logs <run-id> --events --follow` gains
  until-terminal-by-default exit on `run_complete` (with interrupt-only opt-out),
  mirroring loop-logs; help/one-liners and read-only classification stay intact.

## Impact

- **Hosts / packaging:** `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, generated
  plugin skill/command mirrors, any operation-surface one-liners that restate §4.
- **CLI (preferred):** `core/scripts/` logs follow path for advance run-store events
  (reuse or mirror loop-logs until-terminal seam); Commander help strings.
- **Tests:** skill/packaging drift-guard for §4 re-attach language; unit tests for
  until-terminal exit on `run_complete` via injected follow seams (no real network/git).
- **Docs:** README / operator notes for re-attach and until-terminal defaults.
- **Out of scope:** advance-loop stage semantics; review policy; auto-merge (still
  never merges); durable multi-item `/pipeline:loop` resume stranding (#712) —
  this change is **single-issue advance host follow / terminal handoff** after detach.
- **Related (context only):** detached run store + events contract; dual locks /
  detach (#634); run-store visibility (#633); loop until-terminal (#699) as the
  parallel pattern — not duplicates of this issue.
