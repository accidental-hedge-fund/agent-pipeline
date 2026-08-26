## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add an injected `runAdvance` test that burns `MAX_ITERATIONS` so `finalStage` is `pre-merge`, with `auto_loop.enabled: false`. Capture console output and `process.exitCode`. Assert the test **fails** against current code if the run prints `done —` , exits 0, and never calls `setBlocked`. No live network, git, or subprocess.
- [ ] 1.2 Add the same shape at `review-1` (exhausted loop, `auto_loop` off). Assert the test **fails** against current code if the run prints `done —` and exits 0. Do not require `ci-exhausted` at this stage.
- [ ] 1.3 Add an injected pre-merge exhaustion test that asserts `setBlocked` is called with kind `ci-exhausted` and `releaseParkedWorktree` / park-release is attempted. Assert the test **fails** against current code because those calls do not happen today.
- [ ] 1.4 Add a pure helper test for `shouldHandleNonterminalIterationExhaustion` (true for exhausted + `pre-merge` / `review-1`; false for `ready-to-deploy`, `needs-human`, dry-run, and `iterationBudgetExhausted: false`). Verify existing `shouldRunDeferredTerminalFinalize` tests in `core/test/deferred-terminal-finalize.test.ts` still pass.

## 2. Shared post-loop predicate and incomplete signaling

- [ ] 2.1 Export `shouldHandleNonterminalIterationExhaustion({ dryRun, iterationBudgetExhausted, finalStage })` next to `shouldRunDeferredTerminalFinalize` in `core/scripts/pipeline-run.ts`. Verify task 1.4 passes. Do not change `MAX_ITERATIONS`.
- [ ] 2.2 In `runAdvance`, set `iterationBudgetExhausted` only when the `for` loop completes without `break`. After the loop, if `#773` deferred finalize applies, run it and skip the incomplete handler. Else if the new helper is true, skip the ordinary `done —` line, print `iteration budget exhausted at <stage>; re-run pipeline <N> to continue`, and set `process.exitCode` to a non-zero value. Verify tasks 1.1 and 1.2 now fail only on the blocker/park assertions that still need section 3, not on the done/exit assertions.
- [ ] 2.3 Keep in-loop `waiting` / `blocked` / `--once` / label-removed `break`s on the existing path (no exhausted line, no non-zero exit solely from those stops). Verify with an injected `waiting` stop before the cap that the exhausted line is absent and exit code stays 0.

## 3. Pre-merge park-release (reuse ci-exhausted mapping)

- [ ] 3.1 On the incomplete path when `finalStage === "pre-merge"` and not dry-run, materialize a blocked outcome with kind `ci-exhausted` (reuse `autoLoopExhaustedBlockedOutcome`'s kind/diagnostic/offramp mapping; rewrite the reason so it names **iteration-budget** exhaustion, not auto-loop). Call `setBlocked` and `maybeReleaseWorktreeOnPark`. Verify task 1.3 passes. Do not add a `BlockerKind`.
- [ ] 3.2 On the incomplete path when `finalStage` is `review-1` (or any non-`pre-merge` non-terminal stage), do **not** set `ci-exhausted`. Verify task 1.2 still passes without a pre-merge CI block.
- [ ] 3.3 Skip `setBlocked` and park-release under `--dry-run`; still print the exhausted line. Verify with a dry-run fixture that GitHub block/release seams are not called.

## 4. run_complete incomplete marker

- [ ] 4.1 Add additive optional `stop_reason` on `RunCompleteEvent` (`"iteration-budget-exhausted"`). Keep `schema_version` at `1`. Thread it through `finalizeRun` only on the non-terminal exhaustion path. Verify an exhausted `pre-merge` fixture's `events.jsonl` `run_complete` has `stop_reason: "iteration-budget-exhausted"` and `final_state: "pre-merge"`.
- [ ] 4.2 Do not set that `stop_reason` on deferred or in-loop `ready-to-deploy` finalize, or on an in-loop `waiting` stop. Verify with the existing #773 path and the waiting fixture from 2.3.

## 5. Gate

- [ ] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [ ] 5.2 Run `openspec validate advance-iteration-budget-exhaustion` and `npm run ci` from the repo root. Verify both are green. Do not raise `MAX_ITERATIONS`. Do not change `auto_loop` behavior. Do not merge inside advance/loop.
