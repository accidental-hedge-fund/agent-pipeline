## Why

`defaultDeliver` (`core/scripts/event-sink.ts`) settles its delivery promise from whichever fires first between the child's stdin `error` handler and the child's `close` handler. For a forwarder that exits non-zero **without** reading stdin, this is a race: if the child exits before the parent's `stdin.write()` lands, stdin emits an asynchronous EPIPE and the promise rejects with `write EPIPE`; otherwise `close` rejects with `exited N …`. The event-sink tests assert on the close-shaped message (`exited 1`), so under parallel-run CPU contention the EPIPE ordering wins and the suite fails with `ERR_ASSERTION / actual: Error: write EPIPE`. This is the root cause of every "phantom" test-gate failure observed this week — it intermittently fails **any** pipeline run's test gate on this repo, burning a fix attempt each time (the fix harness correctly finds nothing to fix, then the run blocks on "no new commits").

## What Changes

- Make delivery outcome **deterministic** for an early-exiting forwarder: an EPIPE on the child's stdin SHALL NOT settle the delivery promise. It marks the stdin pipe dead and lets the `close` handler settle from the child's exit code (reject non-zero with the redacted stderr excerpt; resolve on zero).
- Preserve the current behavior for **non-EPIPE** stdin errors: they still reject the promise immediately, and a synchronous throw from the stream write still settles through the rejection path with child cleanup (no change to #384's handling).
- Preserve the #343 EPIPE regression guarantee: an early-exiting forwarder never produces an uncaught exception, whether the exit code is zero or non-zero.
- Add a deterministic regression test that forces the EPIPE-before-close ordering and asserts the settled rejection is the close-shaped `exited N` message — closing the flake at its root rather than only loosening the test matcher.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `configurable-event-sink`: refine the "Sink delivery failures are non-fatal" behavior so that, for an early-exiting forwarder, the settled outcome is deterministically driven by the child's **exit code** — a stdin EPIPE does not race the `close` outcome — while non-EPIPE stdin errors and the timeout/spawn-failure/synchronous-throw paths are unchanged.

## Acceptance Criteria

- [ ] The fix lives in `defaultDeliver` (root cause), not in test-matcher loosening alone: a stdin EPIPE marks the pipe dead and does not settle the delivery promise; the `close` handler settles it — reject non-zero with the redacted stderr excerpt, resolve on zero.
- [ ] A non-EPIPE stdin `error` still rejects the delivery promise immediately with that error (today's behavior preserved).
- [ ] The #343 EPIPE regression still holds: an early-exiting forwarder (zero or non-zero exit) never produces an uncaught exception.
- [ ] A deterministic regression test forces the EPIPE-before-close ordering (injected seam, or a forwarder that closes/ignores stdin then exits non-zero after a delay) and asserts the settled rejection is the close-shaped `exited N` message — and it fails without the fix.
- [ ] The full suite passes repeatedly under parallel load (≥5 consecutive runs) with no `ERR_ASSERTION` originating from event-sink tests.
- [ ] `npm run ci` passes (core tests + `build.mjs --check` mirror in sync + install smoke + openspec validate).

## Impact

- `core/scripts/event-sink.ts` — `defaultDeliver` stdin `error` handling.
- `core/test/event-sink.test.ts` — new deterministic EPIPE-ordering regression test; existing close-shaped assertions become race-free.
- Generated `plugin/` mirror after the core change (`node scripts/build.mjs`).
- No config, CLI, or forwarder-contract surface changes; the fix is internal to delivery settlement.
