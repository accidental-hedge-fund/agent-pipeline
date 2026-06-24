## Why

The planning handler sets `pipeline:planning` mid-flight — between generating the plan and
completing the full planning arc — before it can transition the issue onward. If the process
crashes after that label write (e.g. a transient `gh` API error, OOM kill, or SIGINT) the
issue is left stranded on `pipeline:planning` or `pipeline:plan-review`. Re-running
`/pipeline N` from that state returns a 0-transition "waiting" no-op and prints:

```
[pipeline] #N: at planning — waiting: planning is set mid-flight by the planning/plan-review
               handler; nothing to do at this point.
```

The only recovery today is a manual `pipeline triage N --stage ready` to reset the label,
followed by a re-run. This is unnecessary toil: the per-issue lock already serializes
concurrent runs, so if the advance loop has acquired the lock and still sees `planning` or
`plan-review` it can prove no sibling process is actively planning. The issue is
crash-stranded, not in-flight, and the correct response is to restart planning rather than
wait.

## What Changes

- The advance-loop dispatch table in `pipeline.ts` gains re-entrant handling for the
  `planning` and `plan-review` cases: rather than returning a `waiting` outcome, the
  dispatcher rolls the issue back to `ready` (via a `transition()` call) and then calls
  `planningStage.advance()` as if the issue had been on `ready` all along.
- A one-line diagnostic is printed before the rollback so the operator knows a recovered
  crash is happening: `[pipeline] #N: recovered stranded planning attempt — restarting from
  ready`.
- The `plan-review` case is treated identically to `planning` because both represent a
  crashed mid-planning state from which a clean restart (rather than partial resume) is the
  safest and simplest recovery.
- The per-issue lock (`/tmp/pipeline-{domain}-{N}.lock`) remains the only serialization gate.
  By the time the dispatch table is reached, the lock has already been acquired by the current
  process. If a genuine concurrent run were active, the lock acquisition would have failed
  earlier and the current process would never reach the dispatch table. Therefore, at dispatch
  time, `planning` or `plan-review` always means crash-stranded.

## Capabilities

### Modified Capabilities

- `pipeline-state-machine`: The dispatch table's `planning` and `plan-review` cases SHALL
  restart planning (via label rollback + re-dispatch) instead of returning a `waiting` outcome.

## Impact

- `core/scripts/pipeline.ts` — `dispatchStage()` function, `planning` and `plan-review` cases
  in the dispatch switch.
- `core/test/pipeline.test.ts` (or a new `core/test/planning-crash-recovery.test.ts`) — unit
  tests for the new recovery behavior.
- `plugin/` mirror — regenerated after any `core/` change.

## Acceptance Criteria

- [ ] When the advance loop is invoked with stage `planning` (and the lock is held — which is
  always true at dispatch time), the dispatcher rolls the label back to `ready`, logs a
  one-line recovery notice, and restarts planning — it does NOT return a `waiting` outcome.
- [ ] When the advance loop is invoked with stage `plan-review` (same conditions), the
  dispatcher rolls the label back to `ready`, logs a one-line recovery notice, and restarts
  planning — it does NOT return a `waiting` outcome.
- [ ] The recovery diagnostic line follows the pattern:
  `[pipeline] #N: recovered stranded planning attempt — restarting from ready`.
- [ ] A genuine concurrent run is still protected: the per-issue lock prevents a second
  process from ever reaching the dispatch table while a first process is actively planning.
  This invariant is verified by an existing test for the lock; no regression is introduced.
- [ ] A unit test exercises the stranded-`planning` → restart path with a fake
  `transition` dep and a fake `planningStage.advance` dep; it asserts the outcome is an
  advancing result (not `waiting`) and the rollback transition was called.
- [ ] A unit test exercises the stranded-`plan-review` → restart path with the same dep
  seam; it asserts identical behavior to the `planning` case.
- [ ] `npm run ci` passes end-to-end after the change.
