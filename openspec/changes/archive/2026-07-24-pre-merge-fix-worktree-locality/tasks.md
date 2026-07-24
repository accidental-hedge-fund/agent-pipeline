# Tasks

## 1. Confirm the root cause and record it on #547

- [x] 1.1 Re-trace the pre-merge bounded auto-fix path and confirm the harness cwd
      (`invokeFn(harness, wt.path, …)`, `pre_merge.ts:358`) and the salvage/status/HEAD reads
      (`salvageFn(wt.path, …)`, `pre_merge.ts:385`) share the single `wt.path` handle — i.e.
      no intra-function cwd mismatch for this surface.
- [x] 1.2 Confirm the lyric-utils run `648/2026-07-23` clean-worktree signature classification
      (pre-#547 fail-closed rollback vs. executor-seam cwd mismatch vs. harness temp write)
      from `events.jsonl` + `terminal.log` and the code path.
- [x] 1.3 Write the determination to issue #547 so its salvage-extension scope is confirmed
      sufficient or amended.

## 2. Pin worktree locality for the full-fix executor seam

- [x] 2.1 Inspect `invokeStageExecutor` (`fix.ts:572`) and `core/scripts/executors.ts`: verify
      whether an external stage executor can run the harness in a checkout other than the
      issue's managed worktree that salvage later inspects.
- [x] 2.2 If a divergence is possible, ensure the executor runs in the issue worktree (or the
      pipeline inspects the executor's actual worktree) so the harness and salvage never target
      different checkouts.

## 3. Disclose the ran-but-no-recoverable-work outcome

- [x] 3.1 In `performPreMergeAutoFix`, replace the silent clean/no-commit escalation with a
      diagnostic that names the inspected worktree path and states no recoverable harness work
      was found, then escalate to `needs-human`. Leave the dirty-worktree `#547` salvage path
      and the fail-closed rollback mechanics unchanged.
- [x] 3.2 Ensure the equivalent full-fix path surfaces the same disclosure when the harness ran
      but the inspected worktree is clean with no commit.

## 4. Regression tests (deps seams only — no real subprocess/git/network)

- [x] 4.1 Add a worktree-locality test asserting the cwd handed to the fix harness equals the
      path handed to the salvage/status inspection; prove it bites by routing the harness to a
      different checkout.
- [x] 4.2 Add a disclosure test asserting the clean/no-commit pre-merge path escalates with a
      diagnostic containing the inspected worktree path; prove it bites when the disclosure is
      removed.
- [x] 4.3 Confirm the existing `pre-merge-autofix` `#547` salvage and rollback tests still pass
      unchanged.

## 5. Mirror + gate

- [x] 5.1 Regenerate the mirror: `node scripts/build.mjs`; confirm `node scripts/build.mjs
      --check` is clean.
- [x] 5.2 `npm run ci` green (core tests, mirror check, install smoke, `openspec validate --all`).
