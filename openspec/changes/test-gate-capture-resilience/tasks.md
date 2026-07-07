## 1. Surface a "clean exit observed" signal from the capture layer

- [x] 1.1 In `harness.ts`, confirm `runCapped` sets `spawn_error: true` on `child.on("error")` and
  reports the real `exit_code` on `close`; expose whether a clean process exit code was observed
  (reuse `spawn_error` / add a minimal flag) without changing existing callers' behavior.
- [x] 1.2 In `testgate.ts`, extend `RunTestsResult` with a `toolingError: boolean` derived from the
  capture layer (spawn/capture error → true; a genuine non-zero exit → false).

## 2. Bounded tooling-failure retry in `runTestGate`

- [x] 2.1 Add a small internal constant (e.g. `MAX_TOOLING_RETRIES = 2`).
- [x] 2.2 Wrap the initial run and each post-fix run: when `runAndRecord` returns
  `toolingError === true`, re-run the command up to `MAX_TOOLING_RETRIES` times WITHOUT invoking the
  fix harness and WITHOUT decrementing the `max_attempts` fix budget.
- [x] 2.3 A clean exit from any retry proceeds on the normal path (pass → pass; clean non-zero →
  fix loop). Exhausting tooling retries returns a block with a distinct tooling-failure
  `blockReason` (NOT the "test/build gate failed after N fix attempt(s)" wording).

## 3. Fully isolate event-sink write failures

- [x] 3.1 In `event-sink.ts`, ensure a synchronous socket-write throw at `child.stdin.write(line)`
  is caught and converted into the promise rejection path (so it never escapes as an uncaught
  exception); verify `appendEvent` still logs it as a non-fatal diagnostic.
- [x] 3.2 Confirm no gate code path reads sink state, so decision #1 guarantees the gate outcome is
  independent of sink write failures.

## 4. Tail-biased captured-output excerpt

- [x] 4.1 In `testgate.ts`, replace the head-only `truncate` used for the captured command output
  (`MAX_BLOCK_OUTPUT`) with a tail-biased head + middle-elision-marker + tail helper mirroring
  `eval.ts`'s `truncate`.
- [x] 4.2 Leave the dirty-worktree porcelain-path truncation (#352) unchanged.

## 5. Regression tests (`core/test/testgate.test.ts`)

- [x] 5.1 Sink write error + passing command → gate passes: fake a `runTests` that reports exit 0
  while a fake event sink rejects/throws; assert `{ passed: true }` and no `blockReason`.
- [x] 5.2 Truncated/abnormal capture → retry, not fix-attempt consumption: fake `runTests` to return
  `toolingError: true` once then a clean pass; assert the fix harness (`invoke`) was never called
  and `attempts` is 0.
- [x] 5.3 Tooling retries exhausted → block with the distinct tooling-failure reason (not the
  fix-attempt wording).
- [x] 5.4 Cleanly-observed non-zero exit still enters the fix loop (no regression for real
  failures).
- [x] 5.5 Tail-biased excerpt: an over-cap failure output whose summary is in the tail → assert the
  `blockReason` contains the tail summary and a middle-elision marker; an at/under-cap output is
  verbatim.
- [x] 5.6 Prove each test bites: revert the corresponding change and confirm the test fails, then
  restore.

## 6. Mirror + CI

- [x] 6.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror.
- [x] 6.2 `npm run ci` green end-to-end (core tests, mirror check, install smoke, `openspec
  validate --all`).
