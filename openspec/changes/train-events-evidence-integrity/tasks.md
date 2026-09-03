## 1. Biting regressions (inject I/O; prove fail first)

- [ ] 1.1 Add an injected `runTrain` test whose fake `advanceWave` calls `ctx.onLoopReady` / `onRunReady` with a confirmed loop run id and absolute events path, then leaves the wave promise unresolved until the assertion runs. Assert the test **fails** against current code if `train_loop_linked` is missing before the child is terminal. No live network, git, or subprocess.
- [ ] 1.2 Add an injected test that fires live `onLoopReady` and later returns the same `loopRun` on the wave result. Assert the test **fails** against current code if the train stream contains two `train_loop_linked` events for that id, or if a guessed id replaces the live one.
- [ ] 1.3 Add an injected same-clock test: two `initTrainRunStore` (or `runTrain`) calls with the same `now()` and a mkdir seam that reports EEXIST on the unsuffixed id. Assert the test **fails** against current code if both share one run directory or one `events.jsonl` `seq` stream.
- [ ] 1.4 Add an injected allocation-exhaustion test whose mkdir seam fails exclusive create for every `train-*` attempt. Assert the test **fails** against current code if a shared store is written, if `run_id` is published for a colliding id, or if the work-list issues that advance or merge change.
- [ ] 1.5 Add an injected `--merge` already-contained fixture (merged linked PR, containment proven, no merge mutation). Assert the test **fails** against current code if `train_merge_proven` is missing or lacks `proof_disposition` `already-contained`. Keep asserting `train_merge_integrated` is present.
- [ ] 1.6 Add an injected `--merge` newly-merged fixture. Assert the test **fails** against current code if `train_merge_proven` lacks `proof_disposition` `newly-merged`.

## 2. Exclusive train identity

- [ ] 2.1 In `initTrainRunStore`, create `.agent-pipeline/runs/<id>/` with exclusive `mkdir` (`recursive: false`). On EEXIST, retry `train-<timestamp>-2` … up to 8 attempts through the injected mkdir and clock/ID seams, then call existing `initRunDir`. Verify task 1.3 now passes. Do not change advance `initRunDir` resume for issue-prefixed ids. Verify existing `trainRunIdFor` prefix tests still pass.
- [ ] 2.2 When every exclusive attempt fails, create no run directory, skip `train_run_handoff`, omit `run_id`, set `train_status.events_coverage` to `degraded` or `unknown`, and continue `runTrain` mutations. Verify task 1.4 and that `--json` stdout is still exactly one `train_status` object (`schema_version` stays 1).

## 3. Live loop linkage

- [ ] 3.1 Extend the existing `advanceWave` context with `onLoopReady`. Production `advanceWaveThroughLoop` SHALL invoke it from the current `onRunReady` handler after exact `runId` and events path are known and before `runLoopEngine` returns. Verify a unit test of that wiring fires the callback before the engine result is returned.
- [ ] 3.2 In `runTrain`, append `train_loop_linked` from `onLoopReady` once per loop run id, using the exact handoff identity. After the wave returns, confirm the same identity without a second append and without replacing it. Verify tasks 1.1 and 1.2. Keep existing per-wave `loop_run_handoff` on stderr. Keep `--json` stdout as one object.

## 4. Complete merge proof

- [ ] 4.1 In `emitMergeCatalog`, emit `train_merge_proven` whenever containment is proven, including `merged.already`. Set `proof_disposition` to `newly-merged` or `already-contained`. Keep `train_merge_integrated` on both paths. Verify tasks 1.5 and 1.6. Verify a non-merge fixture still omits merge types. Do not add a new event type. Do not change merge-first or merge authority.

## 5. Gate

- [ ] 5.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root. Verify `node scripts/build.mjs --check` is clean.
- [ ] 5.2 Run `openspec validate train-events-evidence-integrity` and `npm run ci` from the repo root. Verify both are green. Do not change train lifecycle, recovery, merge-first, or merge authority. Do not add `pipeline train logs`. Do not merge from advance or loop.
