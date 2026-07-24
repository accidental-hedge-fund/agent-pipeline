## Why

The `extend-fix-harness-salvage-and-discipline` change (#547) extended the
`harness-uncommitted-salvage` fallback to the pre-merge bounded auto-fix path so a
completed-but-uncommitted fix is salvaged instead of discarded. It explicitly **assumed**
"the work reaches the worktree and makes the pipeline preserve it once it does," and split
the question of whether the work reaches the stage worktree **at all** to this issue (#553).

That assumption is not currently checked. On lyric-utils run `648/2026-07-23T01-59-…`
(skill v1.22.0, an override-resume at pre-merge) the fix harness transcript shows a full fix
round — edits to `anomaly.py`/`datasource.py`, new regression tests, a `black` run — yet the
stage worktree ended **clean**: `0 transitions, 662s, nothing to salvage`. Salvage cannot
recover work that is not present in the worktree it inspects, so extending salvage (#547)
alone cannot close this failure mode. The root cause must be determined and the
"work-reaches-the-inspected-worktree" invariant made explicit and checked.

The investigation (traced against current `main`) established:

- **The pre-merge bounded auto-fix path (`performPreMergeAutoFix`, `stages/pre_merge.ts`)
  has no cwd/checkout mismatch.** The harness cwd (`invokeFn(harness, wt.path, …)`,
  `pre_merge.ts:358`) and the salvage/commit/HEAD reads (`salvageFn(wt.path, …)`,
  `pre_merge.ts:385`) share a single `wt.path` handle resolved once from
  `getOnDiskForIssue`. For this surface the `clean / nothing-to-salvage` signature on the
  v1.22.0 run is the **pre-#547 fail-closed rollback** (`git reset --hard <headBefore>` +
  `git clean -fd`) firing before any salvage existed — a case #547 now salvages.
- **The full-fix surface reached via override relabel (`stages/fix.ts`) is different.**
  `runOverride` relabels a `needs-human` item to `review-*` and `runAdvance` can route it
  into the fix stage, whose harness call goes through `invokeStageExecutor` (`fix.ts:572`)
  first and only falls back to `invoke(harness, wt.path, …)` (`fix.ts:584`). When an external
  stage executor is configured, the harness's actual working directory is **not provably**
  the `wt.path` the pipeline later inspects for salvage — a genuine checkout-mismatch seam.
- **The failure was silent.** Whichever discard fired, the run reported
  `0 transitions / nothing to salvage` with **no diagnostic** naming the worktree it looked
  at or stating that completed work went missing. The operator had no signal to distinguish
  "harness legitimately did nothing" from "harness work was discarded / never landed."

This change makes the invariant explicit: the pre-merge fix harness (bounded auto-fix and the
override-relabel full-fix surface) SHALL execute in the exact managed worktree the pipeline
inspects, and when the harness ran but no recoverable work is present there, the pipeline
SHALL fail **loudly** — naming the worktree and escalating — instead of a silent clean/no-op.

## What Changes

- **Pin worktree locality for the pre-merge fix harness.** The fix harness invoked during a
  pre-merge advance / override-resume SHALL run with its process cwd equal to the managed
  worktree path the pipeline subsequently inspects for salvage, new-commit detection, and the
  test gate. This SHALL hold for both the bounded auto-fix `invoke` seam and the full-fix
  `invokeStageExecutor` seam; when an external executor is configured, the executor SHALL run
  in that worktree (or the pipeline SHALL inspect the executor's actual worktree), so the
  harness and the salvage inspection never diverge.
- **Convert the silent discard into a disclosed escalation.** When the pre-merge fix path
  ends with the inspected worktree **clean and no new commit after the harness ran**, the
  pipeline SHALL emit a diagnostic naming the inspected worktree path and stating that no
  recoverable harness work was found there, and escalate to `needs-human` — never a silent
  `0 transitions / nothing to salvage` exit. The existing `#547` salvage behavior for a
  **dirty** worktree, and the existing fail-closed rollback mechanics, are unchanged; only the
  disclosure is added.
- **Regression test the invariant on the deps seams.** A test SHALL assert the cwd handed to
  the fix harness equals the path handed to the salvage/status inspection (failing if a future
  change routes the harness to a different checkout), and that the clean-after-harness path
  escalates with a worktree-naming diagnostic. Tests use the `invokeFn` / executor / salvage
  seams — no real subprocess, git, or network.
- **Record the finding on #547.** The root-cause determination SHALL be written to #547 so its
  salvage-extension scope is confirmed sufficient (work that reaches the worktree is now
  recovered) or amended.

## Capabilities

### New Capabilities

<!-- none -->

### Modified Capabilities

- `harness-uncommitted-salvage`: add requirements that (1) the pre-merge fix harness runs in
  the same worktree the pipeline inspects for salvage/commit/test-gate, and (2) a
  ran-but-no-recoverable-work outcome is a disclosed escalation, not a silent clean/no-op.

## Impact

- Code: `core/scripts/stages/pre_merge.ts` (`performPreMergeAutoFix` disclosure on the
  clean/no-commit escalation), `core/scripts/stages/fix.ts` (executor-seam worktree locality
  for the override-relabel full-fix surface), possibly `core/scripts/executors.ts`. No new
  dependencies.
- Tests: `core/test/pre-merge-autofix.test.ts`, `core/test/pipeline-override.test.ts`, and a
  fix-stage executor-locality test — all on existing DI seams.
- Mirror: regenerate `plugin/` via `node scripts/build.mjs`.
- Behavior: no change to the "pipeline never merges" invariant and no review step removed or
  demoted (golden rules 3, 4). Salvage coverage is **not** extended here (that stays #547);
  this change only guarantees the work is where salvage looks, or the run fails loudly.

## Acceptance Criteria

- [ ] The lyric-utils run `648/2026-07-23` clean-worktree signature is conclusively explained
      and the explanation — classified as (a) pre-#547 fail-closed rollback now covered by
      salvage, (b) full-fix executor-seam cwd mismatch, or (c) harness temp/context write —
      is recorded on issue #547 with the cited code path.
- [ ] The pre-merge fix harness invoked on a pre-merge advance / override-resume runs with
      process cwd equal to the managed worktree path the pipeline inspects for salvage,
      new-commit detection, and the test gate; a regression test on the deps seams asserts the
      harness cwd equals the salvage-inspected path and **fails** if they diverge.
- [ ] If the full-fix executor seam (`invokeStageExecutor`, `fix.ts`) can run in a different
      checkout than the inspected worktree, it is fixed so the executor runs in the issue
      worktree (or the pipeline inspects the executor's actual worktree); a regression test
      bites against the pre-fix code.
- [ ] When the pre-merge fix path ends with the inspected worktree **clean and no new commit
      after the harness ran**, the pipeline emits a diagnostic naming the inspected worktree
      path and escalates to `needs-human` — it never reports a silent `0 transitions /
      nothing to salvage` outcome. A regression test asserts the diagnostic names the worktree
      path and that the item escalates.
- [ ] The `#547` dirty-worktree salvage behavior and the existing fail-closed rollback
      mechanics are unchanged (verified by the existing pre-merge-autofix salvage tests still
      passing); no salvage coverage is extended and no prompt guardrail changed in this change.
- [ ] `node scripts/build.mjs --check` reports the mirror in sync and `npm run ci` is green.
