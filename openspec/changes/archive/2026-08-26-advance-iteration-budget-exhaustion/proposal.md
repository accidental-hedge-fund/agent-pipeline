## Why

A single `pipeline advance` invocation stops after `MAX_ITERATIONS` (= 12) stage dispatches. When a fix-heavy run burns that budget at a **non-terminal** stage, the `for` loop falls out, the run prints `done — <start> → <stage> (N transitions, …)`, writes `run_complete`, and exits 0. Remaining gates never run. There is no park, no `blocked` label, no resume hint. Observed 2026-08-25 on #1243 (PR #1244): `fix-2 → pre-merge` on iteration 11, then `done — ready → pre-merge (12 transitions, 7777s)` with `run_complete final_state=pre-merge`. Pre-merge CI, delta review, and OpenSpec archive never ran.

This is class law, not a #1243 mole. `#773` already deferred `deploy_ready.finalize` when the cap is hit at `ready-to-deploy`. There is no equivalent incomplete-invocation handling for any other stage (`pre-merge`, `review-*`, `fix-*`, `visual-gate`, `eval-gate`, `shipcheck-gate`). The next fix-heavy issue that dies at the cap will look complete unless the post-loop controller treats non-terminal budget death as incomplete.

## What Changes

- When the advance loop exits because `MAX_ITERATIONS` is exhausted and `finalStage` is not `ready-to-deploy`, the invocation SHALL NOT print the ordinary `done — A → B (N transitions, …)` completion summary.
- It SHALL print a distinct `iteration budget exhausted at <stage>; re-run pipeline <N> to continue` line, SHALL exit non-zero, and SHALL NOT emit a `run_complete` event with a terminal-success shape.
- At `pre-merge` specifically, budget exhaustion SHALL materialize the existing `ci-exhausted` / `implementation-ci` blocker (reuse the extracted stage-to-blocker mapping from `autoLoopExhaustedBlockedOutcome`, with an **iteration-budget** reason — never the `auto-loop budget exhausted` prefix) and SHALL `maybeReleaseWorktreeOnPark` so capacity is not stranded.
- At `ready-to-deploy`, the existing #773 deferred finalize SHALL remain (PR tagged, worktree removed) and SHALL NOT regress.
- `MAX_ITERATIONS` stays 12. Auto-loop config and the review-hardening loop stay unchanged. This change does not merge.

**BREAKING:** none for happy-path completion. Operators and supervisors that treated a `done` line plus exit 0 at a mid-flight stage as success will now see a non-zero exit and an exhausted line. That is the bug fix.

## Acceptance criteria

- [ ] An advance invocation that exhausts `MAX_ITERATIONS` with `finalStage` not `ready-to-deploy` does **not** print `done — <start> → <stage> (N transitions, …)`.
- [ ] That same invocation prints `iteration budget exhausted at <stage>; re-run pipeline <N> to continue` (stage and issue number filled in) and ends with a non-zero process exit code.
- [ ] That same invocation does **not** emit a `run_complete` event that a consumer can treat as a successful terminal stop (no ordinary done summary, non-zero exit, and a typed incomplete marker on the event if `run_complete` is still written so logs-follow can end).
- [ ] When the loop **falls through** `MAX_ITERATIONS` (no `break`) and `finalStage` is `pre-merge`, the run materializes blocker kind `ci-exhausted` via the extracted mapping (not `autoLoopExhaustedBlockedOutcome` unchanged) with an iteration-budget reason, and calls `maybeReleaseWorktreeOnPark` on that blocked outcome. `run_complete.final_state` stays `pre-merge`.
- [ ] When `finalStage` is `ready-to-deploy` after the loop, `shouldRunDeferredTerminalFinalize` still runs `deploy_ready.finalize` (PR tagged `pipeline:ready-to-deploy`, worktree removed). Existing #773 tests still pass.
- [ ] A unit test fails if an injected exhausted loop at `pre-merge` or `review-1` with `auto_loop` disabled exits 0, prints the ordinary done summary, and sets no blocker. A second unit test fails if the pre-merge budget-death path does not materialize `ci-exhausted` and does not attempt worktree park-release. Tests inject I/O; no live network, git, or subprocess.
- [ ] OpenSpec deltas cover non-terminal iteration-budget exhaustion. After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This fills a hole in the existing bounded advance loop, not a new family. -->

### Modified Capabilities

- `pipeline-state-machine`: When the per-invocation `MAX_ITERATIONS` cap is exhausted and the issue is not at `ready-to-deploy`, the run SHALL treat that as an incomplete invocation (distinct exhausted line, non-zero exit, no ordinary done summary). At `pre-merge` it SHALL park with `ci-exhausted` and release a safe managed worktree. At `ready-to-deploy` deferred finalize (#773) SHALL remain.
- `events-jsonl-streaming`: A `run_complete` written after non-terminal iteration-budget exhaustion SHALL NOT have a terminal-success shape. If the event is still written so `pipeline logs --events --follow` can end, it SHALL carry a typed incomplete marker (`stop_reason: "iteration-budget-exhausted"` or equivalent additive field; `schema_version` remains `1`).

## Impact

- **Shared controller:** `core/scripts/pipeline-run.ts` `runAdvance` post-loop. Today the loop falling out always prints `done —` and returns without `process.exitCode`. `shouldRunDeferredTerminalFinalize` already special-cases `ready-to-deploy`. Non-terminal fall-out has no equivalent.
- **Shared recipe reuse:** Extract the `pre-merge` → `ci-exhausted` mapping from `autoLoopExhaustedBlockedOutcome`. Pre-merge iteration-budget death SHALL use that mapping plus `maybeReleaseWorktreeOnPark`. The auto-loop helper keeps its auto-loop reason. Do not add a new `BlockerKind`.
- **Auto-loop coexistence:** In-loop auto-loop `continue` / exhausted `break` is unchanged. The new handler runs only on for-loop fall-through. No double-park. No auto-loop exhausted comment on this path.
- **Events:** `core/scripts/run-store.ts` `RunCompleteEvent` / `finalizeRun`. Additive optional `stop_reason`. `final_state` is the pre-park stage. Write `run_complete` before `process.exitCode = 1`. Do not drop `run_complete` if that would hang logs-follow. Do not call `process.exit()`.
- **Tests:** injected advance-loop tests in `core/test/` covering exhausted `pre-merge`, exhausted `review-1`, and non-regression of deferred R2D finalize. No live network, git, or subprocess.
- **Does not:** raise or configure `MAX_ITERATIONS`; change the review-hardening loop; change `auto_loop` config; fix the pre-merge-park re-entry `worktree_unavailable` defect (#1243); merge inside advance/loop; add `auto_merge`.
- **Class vs site:** the site is #1243 / PR #1244 dying at `pre-merge` after 12 transitions. The class is: `MAX_ITERATIONS` fall-out at a non-terminal stage is incomplete, not success. The next issue that burns the cap at `review-1` or `eval-gate` uses the same post-loop handler and does not need a new mole issue.
}
