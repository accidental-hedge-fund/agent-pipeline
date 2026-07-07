## Context

The test/build gate (`core/scripts/testgate.ts`) runs the target repo's own test/build command in
the worktree via `runTests` → `runCapped` (`harness.ts`) and, on failure, drives a bounded
generate→test→fix loop. Because agent-pipeline develops itself, the gate's command for this repo is
`npm run ci`, which runs the pipeline's own test suite — including tests that exercise the run-store
event sink over real sockets.

Two seams collide in issue #384:

1. **Capture vs. telemetry.** While `runCapped` captures the command's stdout/stderr, the pipeline
   also emits stage-accounting events through the run-store event sink (`emitStageAccounting` →
   `appendEvent` → `eventSink` → `defaultDeliver`, `event-sink.ts:83`). A socket-write `EPIPE` on
   the sink surfaced in the captured output and cut it off mid-stream, so the gate recorded a
   failure for a command that actually exits 0.
2. **Failure interpretation.** `runCapped` collapses every non-success into `success: false`
   regardless of whether a clean exit code was observed. A `spawn_error`/broken-capture result is
   therefore indistinguishable, at the gate layer, from a genuine failing test — so a transient
   consumes a fix attempt and escalates to `needs-human`.

The eval gate already solved the excerpt half of this in #373 (tail-biased head+tail elision, see
`eval.ts` `truncate`). This change brings the test gate to parity and adds the two robustness
behaviors above.

## Goals / Non-Goals

**Goals**

- The gate outcome is a pure function of the test command's observed exit code; capture/telemetry
  write failures are non-fatal diagnostics.
- Abnormal capture termination is retried as a bounded tooling failure, never charged as a fix
  attempt, and blocks (if unresolved) with a reason distinct from a real test failure.
- Test-gate failure excerpts are tail-biased so the pass/fail summary survives the cap.

**Non-Goals**

- Redesigning the run-store event-sink transport (explicitly out of scope for #384).
- Touching the eval-gate truncation paths (already fixed in #373).
- Adding new operator config surface — the tooling-retry count is a small internal constant, not a
  new `test_gate.*` key.

## Decisions

### 1. Distinguish "clean exit observed" from "no clean exit"

`runCapped` already sets `spawn_error: true` on `child.on("error")` and otherwise reports the real
`exit_code` on `close`. Surface this cleanly to the gate: `runTests`' `RunTestsResult` gains a signal
(e.g. `toolingError: boolean`, derived from `spawn_error` / the absence of an observed exit) so
`runTestGate` can branch. A cleanly-observed non-zero exit keeps today's behavior (enter the fix
loop). "No clean exit observed" routes to the tooling-retry path.

Rationale: the smallest correct seam. We do not reinterpret timeouts (already handled as a failed
attempt with a timeout marker per the existing "Per-run timeout budget" requirement) — this is only
about spawn/capture abnormal termination.

### 2. Bounded tooling retry inside the gate, before the fix loop

On a tooling error, `runTestGate` re-runs `runAndRecord` up to a small fixed number of tooling
retries (constant, e.g. 2) without invoking the fix harness and without touching the
`max_attempts` fix counter. A clean exit from any retry proceeds normally (pass → pass path; clean
non-zero → fix loop). Exhausting tooling retries returns a block whose `blockReason` is a distinct
tooling-failure message (not routed through `testGateBlockReason`'s "after N fix attempt(s)"
wording), so an operator/recovery harness can tell a plumbing transient from a real regression.

### 3. Isolate event-sink write failures from the gate

`appendEvent` already catches sink delivery rejections and logs them non-fatally. Harden the sink
delivery path so a **synchronous** socket-write throw at `event-sink.ts:83` (`child.stdin.write`)
is also caught and converted into the same non-fatal rejection rather than escaping as an uncaught
exception that can corrupt the surrounding process's output. The gate never reads sink state, so
once the write failure is fully contained, decision #1 guarantees the gate outcome is unaffected.

### 4. Tail-biased excerpt for the captured-output block reason

Replace the head-only `truncate` used for the captured command output (`MAX_BLOCK_OUTPUT`) with a
tail-biased head + middle-elision-marker + tail helper, mirroring `eval.ts`. Scope: the
**captured-command-output** excerpt only. The dirty-worktree porcelain-path truncation (#352) is a
separate, order-sensitive path-list truncation and is left as-is (its existing "truncation is
marked" behavior already holds).

## Risks / Trade-offs

- **Masking a real fast-fail as a transient.** Mitigated by decision #1: only "no clean exit
  observed" retries; any cleanly-observed non-zero exit still fails/fixes immediately. A genuinely
  broken command that always spawn-errors will exhaust the small bounded retry and block with the
  tooling-failure reason — visible, not silently passed.
- **Retry cost.** The tooling-retry count is small and only triggers on abnormal termination, so the
  worst case adds a couple of command runs to an already-rare path.

## Migration / Rollout

Pure internal behavior change; no config or schema changes. Regenerate the `plugin/` mirror and run
`npm run ci`. Existing test-gate scenarios (disabled, detection, dirty-tree, timeout, fix loop)
remain unchanged.

## Open Questions

- Exact tooling-retry constant (proposed: 2) — final value chosen in implementation; the spec only
  requires it to be "bounded".
