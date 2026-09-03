## 1. Biting regressions (inject I/O; prove fail first)

- [x] 1.1 Add an injected `runTrain` test in `core/test/train.test.ts` whose fake `advanceWave` calls `ctx.onLoopReady` with a nonempty run id and no `eventsPath`. Assert the test **fails** against current `publishLiveLoop` if the train stream contains `train_loop_linked`. Assert `events_coverage` stays `ok` or omitted and exit status is unchanged. No live network, git, or subprocess.
- [x] 1.2 Add an injected test whose fake `advanceWave` calls `ctx.onLoopReady` with a nonempty run id and relative events path `runs/abc/events.jsonl`. Assert the test **fails** against current `publishLiveLoop` if the train stream contains `train_loop_linked`. Assert `events_coverage` stays `ok` or omitted.
- [x] 1.3 Add an injected test that publishes a live link for `abc`/`/abs/E` then fires a later `onLoopReady` with `abc`/`/abs/F`. Assert the test **fails** against current run-id-only `linkedLoopIds` if a second link is appended, if the first link is replaced, or if `events_coverage` is not `degraded`. Assert merge, retry, and exit status are unchanged.
- [x] 1.4 Keep the existing #1301 live-absolute append-once fixture (`abc`/`/abs/E` from awaited `onLoopReady`, later same identity on the wave result). Verify it still asserts exactly one `train_loop_linked` with `events` equal to `/abs/E` before the child is terminal.
- [x] 1.5 Add an injected test that publishes a live link for `abc`/`/abs/E` then a later wave reports `def`/`/abs/E`. Assert exactly one `train_loop_linked` keeping `abc`/`/abs/E`, and `events_coverage` equal to `degraded`. Assert merge, retry, and exit status are unchanged.

## 2. Append-site admission and full-identity dedup

- [x] 2.1 In `publishLiveLoop`, append `train_loop_linked` only when the handoff has a nonempty trimmed run id and a nonempty path that Node `path.isAbsolute` accepts. Omit when the path is missing, empty, or relative. Do not invent a path. Do not set `events_coverage` to `degraded` for that omit. Verify tasks 1.1 and 1.2 now pass. Reuse the existing callback; do not add an identity helper type.
- [x] 2.2 Change `linkedLoopIds` from a run-id `Set` to a full-identity lookup (run id → absolute path, plus the reverse path → run id). Same pair is a no-op. A later `onLoopReady` that disagrees on path or run id for an already published live link keeps the first event, does not append, and sets `events_coverage` to `degraded`. Keep `liveLoopByWave` as the per-wave confirm site. Wave-result `loopRun` still does not append and applies the same bidirectional identity check. A later wave with a new run id and a new path still appends once. Verify task 1.3, task 1.4, and task 1.5. Verify the existing #1301 wave-result mismatch fixture still degrades coverage and keeps the first link.

## 3. Producer admission

- [x] 3.1 In production `advanceWaveThroughLoop`, invoke `onLoopReady` only when `onRunReady` supplies a nonempty run id and a nonempty absolute events path. Do not present `out.loopRun` as a followable live identity without that pair. Verify an existing awaited-`onLoopReady` source test still fails if the callback is fire-and-forget. Verify tasks 1.1–1.4 still pass. Do not change advance outcomes, merge, retry, or exit status.

## 4. Gate

- [x] 4.1 After any `core/` edit, run `node scripts/build.mjs` from the repo root. Verify `node scripts/build.mjs --check` is clean.
- [x] 4.2 Run `openspec validate train-loop-linked-absolute-identity` and `npm run ci` from the repo root. Verify both are green. Do not change train scheduling, recovery, merge-first, or merge authority. Do not add a collector or a new event type. Do not merge from advance or loop.
