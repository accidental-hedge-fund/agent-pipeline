## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected `runAdvance` test that burns `MAX_ITERATIONS` so the loop **falls through** at `pre-merge`, with `auto_loop.enabled: false`. Capture console output and `process.exitCode`. Assert the test **fails** against current code if the run prints `done —`, leaves `process.exitCode` 0/`undefined`, and never calls `setBlocked`. No live network, git, or subprocess.
- [x] 1.2 Add the same fall-through shape at `review-1` (`auto_loop` off). Assert the test **fails** against current code if the run prints `done —` and exits 0. Do not require `ci-exhausted` at this stage.
- [x] 1.3 Add an injected pre-merge fall-through test that asserts `setBlocked` is called with kind `ci-exhausted` and a reason that names iteration-budget exhaustion (not `auto-loop budget exhausted`), and that `releaseParkedWorktree` is attempted. Assert the test **fails** against current code because those calls do not happen today.
- [x] 1.4 Add a pure helper test for `shouldHandleNonterminalIterationExhaustion({ iterationBudgetExhausted, finalStage })` (true for exhausted + `pre-merge` / `review-1`; false for `ready-to-deploy`, `needs-human`, and `iterationBudgetExhausted: false`). Do **not** gate the helper on `dryRun`. Verify existing `shouldRunDeferredTerminalFinalize` tests in `core/test/deferred-terminal-finalize.test.ts` still pass.

## 2. Shared post-loop predicate and incomplete signaling

- [x] 2.1 Export `shouldHandleNonterminalIterationExhaustion` next to `shouldRunDeferredTerminalFinalize` in `core/scripts/pipeline-run.ts`. In `runAdvance`, hoist the loop index (`let i = 0; for (; i < MAX_ITERATIONS; i++)`) and set `iterationBudgetExhausted = (i === MAX_ITERATIONS)` after the loop. That flag stays false for every explicit `break` (`waiting`, `blocked`, `no-op`, `error`, `finalized`, `--once`, label removed, in-loop R2D, needs-human, auto-loop exhausted park). Verify task 1.4. Do not change `MAX_ITERATIONS`.
- [x] 2.2 After the loop, if `#773` deferred finalize applies, run it and skip the incomplete handler. Else if the new helper is true: snapshot `exhaustionStage = finalStage` **before** any park; skip the ordinary `done —` line; print `iteration budget exhausted at <stage>; re-run pipeline <N> to continue`; set `process.exitCode = 1` **after** the inner `finally` writes `run_complete`. Never call `process.exit()`. Verify tasks 1.1 and 1.2 now fail only on the blocker/park assertions that still need section 3.
- [x] 2.3 Inject a `waiting` `break` on the last slot (`i === MAX_ITERATIONS - 1`). Assert: no exhausted line, `process.exitCode` stays 0/`undefined`, persisted `run_complete` has no `stop_reason: "iteration-budget-exhausted"`.

## 3. Pre-merge park-release (reuse extracted ci-exhausted mapping)

- [x] 3.1 Extract the stage-to-blocker mapping from `autoLoopExhaustedBlockedOutcome` (pre-merge → `ci-exhausted` + `ci-failed` offramp). Keep the auto-loop helper's reason prefix unchanged. On the incomplete path when `exhaustionStage === "pre-merge"` and not dry-run, materialize a blocked outcome from that mapping with an **iteration-budget** reason. Call `deps.setBlocked ?? setBlocked` and `maybeReleaseWorktreeOnPark`. Do not overwrite `finalStage`. Verify task 1.3. Do not add a `BlockerKind`.
- [x] 3.2 On the incomplete path when `exhaustionStage` is `review-1` (or any non-`pre-merge` non-terminal stage), do **not** set `ci-exhausted`. Verify task 1.2 still passes without a pre-merge CI block.
- [x] 3.3 Skip `setBlocked` and park-release under `--dry-run`; still print the exhausted line. Verify with a dry-run fixture that GitHub block/release seams are not called.
- [x] 3.4 Auto-loop coexistence: (a) in-loop auto-loop exhausted `break` still uses `autoLoopExhaustedBlockedOutcome` and does **not** print the iteration-budget exhausted line or set `stop_reason: "iteration-budget-exhausted"`; (b) fall-through after an auto-loop `continue` on the last slot uses the iteration-budget path, not `buildAutoLoopExhaustedComment`.

## 4. run_complete incomplete marker

- [x] 4.1 Add additive optional `stop_reason` on `RunCompleteEvent` (`"iteration-budget-exhausted"`). Keep `schema_version` at `1`. Thread it through `finalizeRun` as an optional field so every existing call site stays compatible (omit = today's event). On the non-terminal exhaustion path, set it from the pre-park snapshot. Verify the exhausted `pre-merge` fixture's **persisted** `events.jsonl` `run_complete` has `stop_reason: "iteration-budget-exhausted"`, `final_state: "pre-merge"` (not `blocked`), and `schema_version: 1`.
- [x] 4.2 Do not set that `stop_reason` on deferred or in-loop `ready-to-deploy` finalize, or on the waiting-before-cap fixture from 2.3. Verify existing #773 deferred finalize still tags the PR and removes the worktree. Add a `finalizeRun` unit case: omitted `stop_reason` leaves the field absent.

## 5. Gate

- [x] 5.1 After any `core/` edit, run `node scripts/build.mjs` and include regenerated `plugin/` in the same change. Verify `node scripts/build.mjs --check` is clean.
- [x] 5.2 Run `openspec validate advance-iteration-budget-exhaustion` and `npm run ci` from the repo root. Verify both are green. Do not raise `MAX_ITERATIONS`. Do not change in-loop `auto_loop` continuation. Do not merge inside advance/loop.
