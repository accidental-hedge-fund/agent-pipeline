## Context

`defaultDeliver` spawns the operator's forwarder command with `stdio: ["pipe", "ignore", "pipe"]`, writes the event line to stdin, and settles a single promise. Two independent events can settle it:

- `child.on("close", code)` → resolve on `code === 0`, else reject `event sink command exited <code>: <redacted stderr>`.
- `child.stdin.on("error", err)` → reject `err` (added in #343 to stop an EPIPE from an early-exiting forwarder escaping as an uncaught exception).

Both are guarded by a shared `settled` flag, so **whichever fires first wins**. For a forwarder that exits non-zero without reading stdin, the parent's `stdin.write()` can land after the child is gone, producing an asynchronous `EPIPE`. Under parallel-run CPU contention that `EPIPE` frequently fires before `close`, so the promise rejects with `write EPIPE` instead of the exit-code message. The tests assert the exit-code message, so they flake — the root cause of this week's phantom test-gate failures.

## Goals / Non-Goals

- Goal: the settled outcome for an early-exiting forwarder is a deterministic function of the child's exit code, independent of EPIPE-vs-close timing.
- Goal: preserve #343 (no uncaught exception on early-exit EPIPE) and #384 (synchronous write throw settles + cleans up).
- Non-Goal: change the forwarder command contract, redaction, timeout, or the gate-side handling of genuinely failing test runs (#384's tooling-error retry is separate).

## Decision

Treat a stdin `EPIPE` as **information about a dead pipe, not a delivery outcome**. In the stdin `error` handler:

- If the error is an `EPIPE`, do not set `settled` and do not reject. The write target is gone; stop writing and let the existing `close` handler settle from the exit code (the child is exiting or has exited, so `close` is imminent).
- If the error is anything else, keep today's behavior: reject the promise immediately with that error (and clean up the timer/child as today).

Because `stdio[0]` is a pipe and the child is exiting, `close` is guaranteed to follow, so the promise still settles (and the timeout remains the ultimate backstop). This is a root-cause fix: the close-shaped assertions become race-free without loosening the test matcher.

### Alternatives considered

- **Loosen the test matcher to accept `write EPIPE`** — rejected: hides the non-determinism, and callers/operators would see two different rejection shapes for the same failure. The acceptance criteria explicitly require a root-cause fix, not matcher-only.
- **Delay/await the stdin write before spawning close handling** — rejected: adds ordering complexity and can't eliminate the async EPIPE, which originates in the kernel pipe, not our sequencing.
- **Swallow all stdin errors** — rejected: a genuine non-EPIPE stdin failure (e.g. the pipe breaking for a reason unrelated to a clean early exit) should still surface as a rejection, matching prior behavior.

## Risks / Trade-offs

- If a forwarder emitted an EPIPE but somehow never closed, settlement would fall to the 10s `DELIVERY_TIMEOUT_MS` backstop rather than an immediate reject. This is acceptable: a pipe-only child with no close is pathological, the outcome is still non-fatal (appendEvent treats it as a warning), and the timeout already exists for hung forwarders.

## Test Strategy

- Deterministic ordering test: force EPIPE-before-close (inject a stdin whose `write` triggers a synchronous/next-tick `EPIPE` while the child exits non-zero after a small delay, or a fake `deliver` seam that emits `EPIPE` then `close`) and assert the rejection message includes `exited` and not `write EPIPE`. Verify it fails against the pre-fix handler.
- Keep the existing #343 uncaught-exception guard and #384 synchronous-throw test green.
- Soak: run the event-sink suite ≥5 times under load with no `ERR_ASSERTION`.
