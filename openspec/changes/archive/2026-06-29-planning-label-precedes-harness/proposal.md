## Why

Issue #323 asks that `pipeline:planning` be set **before** the planning harness runs, so the
label accurately reflects active work for the full harness duration (20–40 min for OpenSpec)
instead of leaving the issue at `pipeline:ready` until authoring finishes.

The requested **runtime behavior already shipped** on `main` in commit `61f1a5f`
(_"fix: improve pipeline throughput observability"_). That commit refactored
`runPlanningPhases` to record stage-lifecycle events and, as a side effect, (a) moved the
`ready → planning` transition to **before** `authorArtifact` and (b) reclassified
planning-stage blocks from `ready` to `planning`. So the issue's observable behavior is
present today — but it was introduced incidentally by an observability commit, and:

1. **No spec requirement** governs the timing of the `pipeline:planning` label. The behavior
   is undocumented and therefore unprotected against silent regression — exactly the drift the
   convergence lessons warn about (a behavior not anchored in a spec can be quietly moved back
   by a future refactor).
2. **Test coverage is partial.** The transition-before-authoring ordering is locked by
   `planning.test.ts:725`, and the plan-generation-failure block path is asserted to be
   `planning` (`planning.test.ts:721`), but the **bootstrap-creation**, **bootstrap-setup**,
   and **OpenSpec validation** block paths do not assert their stage classification — they
   check tag and reason only.

This change closes those two gaps: it **codifies the invariant as a `pipeline-state-machine`
requirement** and **completes the regression coverage** so the behavior #323 requests cannot
silently regress. It is a spec-and-test change; **no production code change is required**
because `61f1a5f` already implements the behavior.

## What Changes

- Add a `pipeline-state-machine` requirement stating that the planning stage SHALL transition
  `ready → planning` **before** invoking any planning harness, and that every block raised
  while the planning stage is executing (before the `plan-review`/`implementing` transition)
  SHALL classify the stage as `planning`, never `ready`.
- Complete the regression coverage in `planning.test.ts` so **all four** planning-stage block
  paths — bootstrap-creation, bootstrap-setup, plan-generation, and OpenSpec validation —
  assert their `setBlocked` stage is `planning` (today only plan-generation does).
- Keep (and explicitly reference) the existing ordering test that asserts the `ready →
  planning` transition happens before `authorArtifact`, and the lifecycle-sequence test that
  proves the `planning → plan-review` and `planning → implementing` transitions are
  unaffected.
- No production code change: `core/scripts/stages/planning.ts` already exhibits the behavior
  as of `61f1a5f`. If implementation review finds the behavior is NOT present (e.g. a
  regression landed between proposal and implementation), restore it as the minimal fix.

## Capabilities

### Modified Capabilities

- `pipeline-state-machine`: add a requirement that fixes the timing of the `pipeline:planning`
  label (set before any harness invocation) and the stage classification of planning-stage
  blocks (`planning`, not `ready`).

## Impact

- `openspec/specs/pipeline-state-machine/spec.md` — new requirement (via the change delta;
  archived at pre-merge).
- `core/test/planning.test.ts` — extend the blocker-equivalence tests to assert
  `stage === "planning"` for the bootstrap-creation, bootstrap-setup, and validation paths.
- `core/scripts/stages/planning.ts` — **no change expected** (behavior already present); listed
  only as the subject the spec governs.
- `plugin/` mirror — regenerated only if any `core/` file changes (test-only changes still
  require `node scripts/build.mjs` + a synced mirror to keep CI green).

## Acceptance Criteria

- [ ] The `pipeline-state-machine` spec carries a requirement stating that the planning stage
  sets `pipeline:planning` (transition `ready → planning`) **before** any planning harness is
  invoked, with at least one `#### Scenario:` making that ordering precise.
- [ ] The same requirement states that any block raised while the planning stage is executing
  (before the `plan-review`/`implementing` transition) classifies the stage as `planning`,
  not `ready`, with a scenario covering it.
- [ ] A regression test asserts the `ready → planning` transition is observed by
  `authorArtifact` (the label is set before the authoring harness runs) — the existing
  `planning.test.ts` "transitions ready to planning before authoring" test satisfies this and
  remains green.
- [ ] Regression tests assert that **all four** planning-stage block paths set
  `setBlocked` stage to `"planning"`: bootstrap-creation failure, bootstrap-setup failure,
  plan-generation failure, and OpenSpec validation failure.
- [ ] A test proves the new block-stage assertions bite: reverting any planning-stage
  `setBlocked(..., "planning", ...)` literal back to `"ready"` makes a test fail.
- [ ] The `planning → plan-review` and `planning → implementing` transitions are unchanged,
  proven by the existing lifecycle-sequence test remaining green.
- [ ] `openspec validate planning-label-precedes-harness --strict` passes.
- [ ] `npm run ci` passes end-to-end (core tests, `build.mjs --check` mirror sync, install
  smoke).
