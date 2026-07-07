## Why

The planning handler sets `pipeline:implementing` mid-flight — after plan-review approves,
before the implementation harness does any work — while holding the repo-stable
live-planning marker across the *entire* `ready → review-1` arc. If the process is killed
after that label write but before any commits land (host session teardown, OOM, SIGINT),
the issue is stranded on `pipeline:implementing` with no worktree and no committed work.

The `implementing` re-entry dispatch (`dispatchResume`, #175) only knows how to *resume* a
crash that left commits behind: if a worktree with commits ahead of base exists it runs the
post-implementation steps, otherwise it returns a `waiting` "nothing to do" outcome and the
run exits 0. So a crash-stranded `implementing` with no commits no-ops forever — no error,
no `blocked` label — and every subsequent `/pipeline N` prints the same healthy-looking line
and exits 0. The only recovery today is a manual `pipeline triage N --stage plan-review`
(or `ready`) label rewind, after which the existing planning crash-recovery path takes over.

The stranded-attempt recovery already exists for the `planning` / `plan-review` entry points
(#271 / `planning-crash-recovery`). It is simply not reachable from an entry at
`implementing`. This change closes that gap.

## What Changes

- The `implementing` re-entry dispatch gains crash-stranded recovery, gated on the same
  repo-stable live-planning marker used by the `planning` / `plan-review` recovery:
  - **Live owner** (marker present, PID alive): a concurrent run genuinely owns the
    implementing stage → return `waiting` (unchanged, but the reason now names the live
    owner instead of the ambiguous "nothing to do at this point").
  - **No live owner + worktree has commits ahead of base**: resume the post-implementation
    steps (test gate → push → PR → `review-1`) — the existing #175 resume path, preserved.
  - **No live owner + no salvageable commits**: crash-stranded → roll the label back to
    `ready` via a `transition()` call, log a one-line recovery diagnostic, and restart the
    planning arc via `planningStage.advance()` — identical to the `planning` / `plan-review`
    recovery.
- The recovery ordering is **liveness first**: the marker check runs before the
  commits-ahead check, so a live cross-domain implementer is never resume-raced and a dead
  run with no commits is never left waiting.
- The residual `waiting` outcome at `implementing` (a live concurrent run) keeps exit code 0:
  it is a genuine, healthy "another process is working" wait, not a stall. The silent
  permanent stall is eliminated by the recovery itself, not by changing the exit code. (See
  `design.md` for why a WARNING / non-zero exit was considered and rejected.)

## Capabilities

### Modified Capabilities

- `implementing-resume`: the `implementing` re-entry dispatch SHALL gate on the live-planning
  marker and, when no live run owns the stage and no commits are salvageable, restart the
  planning arc from `ready` instead of returning a `waiting` "nothing to do" outcome. The
  no-commits → `waiting` scenario is narrowed to no-commits **AND a live owner**.

## Impact

- `core/scripts/stages/planning.ts` — `dispatchResume()`: add the live-marker gate and the
  crash-stranded restart branch (reusing `transition()` + `planningStage.advance()`).
- `core/scripts/pipeline-run.ts` — the `implementing` case in `dispatch()` passes the
  existing `PlanningRecoveryDeps` (marker + `transition` + `planningAdvance`) through to
  `dispatchResume` so the recovery is unit-testable via the same seam as the planning path.
- `core/scripts/stages/planning.test.ts` (or a new `implementing-crash-recovery.test.ts`) —
  unit tests for the new recovery behavior and the preserved resume/waiting branches.
- `plugin/` mirror — regenerated after any `core/` change.

## Acceptance Criteria

- [ ] A fresh `pipeline N` on an issue stranded at `pipeline:implementing` with **no live
  owner and no worktree commits** rolls the label back to `ready`, logs the recovery
  diagnostic, and restarts planning — it does **not** return a `waiting` outcome and does
  **not** exit as a 0-transition no-op.
- [ ] The recovery diagnostic follows the pattern
  `[pipeline] #N: recovered stranded implementing attempt — restarting from ready`.
- [ ] When a worktree with commits ahead of `cfg.base_branch` exists and no live owner holds
  the marker, the dispatch still resumes the post-implementation steps (test gate → push →
  PR → `review-1`) — the #175 resume path is preserved, not regressed.
- [ ] When the live-planning marker is present with a live PID, the dispatch returns
  `{ advanced: false, status: "waiting" }` and does **not** roll back, restart, or touch the
  worktree — a genuine concurrent implementing run is never resume-raced.
- [ ] The residual `waiting` outcome's reason string names the live concurrent owner (not the
  ambiguous "nothing to do at this point"), so an orchestrator can distinguish a healthy
  concurrent wait from the former silent stall.
- [ ] The liveness check runs **before** the commits-ahead check in the dispatch ordering.
- [ ] A unit test drives the crash-stranded path (marker absent/dead, no commits) with fake
  `transition` / `planningAdvance` / marker deps and asserts the rollback transition was
  called `(cfg, N, "implementing", "ready", <string>)` and the outcome advances.
- [ ] A unit test drives the live-owner path (marker PID alive) and asserts a `waiting`
  outcome with no `transition` / `planningAdvance` / resume calls.
- [ ] A unit test drives the resume path (no live owner, commits present) and asserts the
  post-implementation resume runs and the recovery restart does **not**.
- [ ] The regression test bites: reverting the dispatch change makes the crash-stranded test
  fail (it re-observes the old `waiting` no-op).
- [ ] `npm run ci` passes end-to-end (core tests + `build.mjs --check` mirror sync +
  `openspec validate --all`).
