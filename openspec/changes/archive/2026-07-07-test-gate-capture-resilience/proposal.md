## Why

During a fix-round test gate the pipeline emits stage-accounting events through the run-store
event sink while `runTests` captures the test command's stdout/stderr. When the event sink's
socket write fails mid-run (`Socket._write` → `event-sink.ts:83`), the gate's captured output
can terminate mid-stream: the gate records a **failure** even though the repo's own test command
(`npm run ci`) actually passes, and the failure excerpt is head-biased so it is cut off inside an
unrelated *passing* test's `console.log` — showing no evidence of any real failure. The recovery
fix harness then correctly concludes "nothing to fix", produces no commit
(`No commits found in the range…`), and the run escalates to `needs-human`. In run
`372-2026-07-06T22-01-03-714Z` this converted a capture-plumbing transient into a false blocker;
re-running the same gate with zero code changes passed, and the recovery harness ran `npm run ci`
8 consecutive times clean.

## What Changes

- **Gate outcome derives solely from the test command's observed exit code.** A write failure in
  the run-store event sink (or any telemetry/log-capture write) during the gate SHALL NOT fail the
  gate; such errors are recorded as non-fatal tooling diagnostics.
- **Abnormal output-capture termination is retried as a tooling failure, not a fix attempt.** When
  the command's output capture ends before a clean process exit code is observed (a spawn/capture
  error rather than a genuine non-zero exit), the gate re-runs the command a bounded number of
  times instead of invoking the fix harness. A clean non-zero exit remains a genuine test failure
  that enters the fix loop; retries never consume `test_gate.max_attempts` budget. If retries are
  exhausted without a clean exit, the gate blocks with a **tooling-failure** reason distinct from a
  test-failure reason.
- **Test-gate failure excerpts become tail-biased** (head + middle-elision marker + tail),
  consistent with the eval-gate truncation fix (#373), so the pass/fail summary survives the cap
  instead of the excerpt ending inside leading boilerplate.

## Capabilities

### Modified Capabilities

- `test-build-gate`: adds requirements that (1) the gate outcome is determined solely by the test
  command's observed exit code and capture/telemetry write failures are non-fatal diagnostics,
  (2) abnormal output-capture termination is retried as a bounded tooling failure rather than
  charged as a fix attempt, and (3) the captured-output failure excerpt preserves the summary tail.

## Impact

- `core/scripts/testgate.ts` — `runTests`/`runTestGate`: surface a "no clean exit observed" tooling
  signal, add the bounded tooling-failure retry, and replace head-only `truncate` with a tail-biased
  head+tail elision for the captured-output excerpt.
- `core/scripts/harness.ts` — `runCapped`/`HarnessResult`: expose whether a clean process exit code
  was observed (vs. a spawn/capture error) so the gate can distinguish tooling failures from test
  failures (the `spawn_error` seam already exists).
- `core/scripts/run-store.ts` / `core/scripts/event-sink.ts` — ensure event-sink delivery write
  failures (including synchronous socket-write throws) stay non-fatal and never propagate into the
  gate; no transport redesign.
- `core/test/testgate.test.ts` — regression tests for the three behaviors.
- `plugin/` mirror — regenerated after the `core/` change.

## Acceptance Criteria

- [ ] A run-store event-sink (or other telemetry/log-capture) write failure that occurs while the
  test command runs and exits **0** results in the gate **passing** — the gate outcome equals the
  command's exit code, and the sink error is logged as a non-fatal diagnostic (never surfaced as a
  `blockReason`).
- [ ] When the test command's output capture terminates abnormally (no clean exit code observed —
  a spawn/capture error), the gate **re-runs the command** rather than invoking the fix harness;
  the re-run does not decrement or consume `test_gate.max_attempts`.
- [ ] When a bounded tooling-failure retry produces a clean exit, the gate reports that result
  (e.g., a clean pass yields `{ passed: true, attempts: 0 }` with zero fix-harness invocations).
- [ ] When tooling-failure retries are exhausted without ever observing a clean exit, the gate
  blocks with a **tooling-failure** reason that is distinct from the ordinary "test/build gate
  failed after N fix attempt(s)" test-failure reason.
- [ ] A cleanly-observed **non-zero** exit is still treated as a genuine test failure that enters
  the bounded generate→test→fix loop (no behavior regression for real failures).
- [ ] When the captured command output exceeds the block-output cap, the failure excerpt is
  **tail-biased** — it contains a leading head fragment, an explicit middle-elision marker stating
  how much was dropped, and the trailing summary — so the pass/fail summary survives.
- [ ] Regression tests cover: (a) sink write error + passing command → gate passes; (b) truncated
  capture → command retry, not fix-attempt consumption; (c) excerpt shows the tail. Each test is
  proven to bite (fails without the fix).
- [ ] `npm run ci` passes end-to-end after the change (including the `plugin/` mirror check).
