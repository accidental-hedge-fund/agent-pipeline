## Context

Issue #323 reports that `pipeline:planning` is set *after* the planning harness authors its
artifact, leaving the issue on `pipeline:ready` for the full 20–40 min harness run. The issue
cites `planning.ts` lines 303/323 — line numbers from the pre-refactor file structure.

The current code tells a different story. Commit `61f1a5f`
(_"fix: improve pipeline throughput observability"_, on `main`) rewrote `runPlanningPhases` to
record split stage-lifecycle events (`stage_start`/`stage_complete` for `planning`,
`plan-review`, `implementing`). To make those events accurate, the same commit:

- moved `doTransition(cfg, issueNumber, "ready", "planning", ...)` to the **top** of
  `runPlanningPhases` (now line 404), before `gatherCarryForward`, `bootstrapWorktree`, and
  `hooks.authorArtifact` (line 443); and
- changed the planning-stage `setBlocked` calls from stage `"ready"` to `"planning"` (bootstrap
  failure line 428, authorArtifact failure line 445; validation uses
  `validateResult.blockStage`, which both hook sets supply as `"planning"`).

So the behavior #323 requests is already live. What is missing is the **contract**: nothing in
`openspec/specs/` requires this timing, and the regression coverage is partial.

### Existing test coverage (verified)

- `planning.test.ts:725` — "transitions ready to planning before authoring": asserts the
  `ready → planning` transition fires before `authorArtifact`. ✅ ordering locked.
- `planning.test.ts:711` — "blocker equivalence: plan-generation failure": asserts
  `stage === "planning"` for the authorArtifact-failure path. ✅
- `planning.test.ts:688` / `:698` — bootstrap creation / setup failures: assert tag + reason
  only, **not** stage. ❌ gap.
- OpenSpec validation failure: no blocker-equivalence case asserts its stage. ❌ gap.
- `planning.test.ts:746` — lifecycle-sequence test: proves `planning → plan-review →
  implementing` ordering is intact. ✅ downstream-unaffected locked.

## Goals / Non-Goals

**Goals:**
- Anchor the planning-label-timing behavior in a `pipeline-state-machine` requirement so a
  future refactor cannot silently move the transition back after the harness.
- Close the two block-path coverage gaps (bootstrap creation/setup, OpenSpec validation) so all
  four planning-stage blocks are asserted to classify the stage as `planning`.

**Non-Goals:**
- Changing production code. The behavior already exists; this change adds a spec + tests. A
  code change is in scope only as a fallback if implementation review discovers the behavior
  regressed since `61f1a5f`.
- Changing label timing for any other stage, or the order in which the plan comment is posted
  (explicitly out of scope per the issue).
- Re-litigating the lifecycle/observability design from `61f1a5f`.

## Decisions

### Decision: ADD a requirement rather than MODIFY one

There is no existing `pipeline-state-machine` requirement about *when* the planning label is
set or how planning-stage blocks are classified, so the delta is an addition, not a
modification. The state-machine spec already owns the canonical stage sequence and transition
semantics, making it the correct home for this label-timing invariant.

### Decision: spec + tests, not a code change

`61f1a5f` already satisfies all three of #323's acceptance criteria at runtime. Re-implementing
the transition move would be a no-op diff and would violate surgical-fix discipline. The honest,
minimal deliverable is to (a) write the missing spec and (b) extend the existing
blocker-equivalence tests to assert the stage for the two untested planning-stage block paths.
Task 1.3 retains a fallback to restore the behavior only if it has regressed by implementation
time.

### Decision: scope the block-stage invariant to the pre-`plan-review` window

Blocks raised *after* the `planning → plan-review` transition are legitimately classified
`plan-review`. The requirement therefore scopes "planning-stage blocks" to those raised before
that transition, matching the four `setBlocked(..., "planning", ...)` sites and avoiding any
implication that downstream blocks should change.

## Risks / Trade-offs

- **Risk: the behavior regresses between proposal and implementation.** Mitigated by task 1.1–
  1.3, which verify the runtime behavior and restore it minimally if absent.
- **Trade-off: a test-only `core/` change still requires a `plugin/` mirror regeneration.**
  Accepted — `build.mjs --check` is part of `npm run ci`, so the mirror must be regenerated and
  committed regardless of how small the `core/` change is.
