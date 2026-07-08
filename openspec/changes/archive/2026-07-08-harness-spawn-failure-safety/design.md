## Context

`runCapped(cmd, args, cwd, …)` in `core/scripts/harness.ts` runs a harness CLI and returns a
`HarnessResult`. It is the single spawn chokepoint for `claude`, `codex`, and custom reviewer
CLIs (all via `invoke()`). It already carries a family of "never crash / always resolve"
robustness guarantees owned by the `harness-descendant-cleanup` capability: a bounded secondary
deadline on timeout, an `onCaptureError` handler for mid-run stdout/stderr stream errors, and a
downstream stream-forward guard. Async spawn failures are handled by `child.on("error")`, which
`invoke()` maps to `spawn_error: true`.

## The gap

`spawn()` has two failure surfaces:
- **Asynchronous** — the OS-level launch fails (ENOENT, EACCES). Node emits `'error'` on the
  child object. Handled today by `child.on("error")` → `spawn_error: true`.
- **Synchronous** — Node rejects the *arguments* before launching: an argv entry containing a NUL
  byte throws `TypeError [ERR_INVALID_ARG_VALUE]: The argument 'args[N]' must be a string without
  null bytes`. This is thrown from the `spawnImpl(cmd, args, …)` call itself.

The synchronous throw happens inside the `new Promise((resolvePromise) => { … })` executor.
An exception thrown synchronously in a Promise executor rejects the promise. `runCapped`'s
callers (`invoke`, `invokeReviewer`, `invokePromptHarnessReview`, `advanceReview`) `await` a
`HarnessResult` and have no `try/catch` for a rejection at that seam, so it becomes an unhandled
rejection that crashes the process. The reviewer prompt is built from the reviewed diff, so any
NUL byte in the reviewed content is the trigger.

## Decision

Wrap only the `spawnImpl(...)` call in a `try/catch` inside `runCapped`. On catch, resolve (never
reject) a terminal `HarnessResult`:

```
{ success: false, stdout: "", stderr: <marker?> + "[harness <label>] spawn error: " + err.message,
  exit_code: -1, duration: <elapsed>, timed_out: false, spawn_error: true }
```

Reusing `spawn_error: true` is deliberate: it is the exact flag the async path sets, so every
downstream consumer — `invoke()`'s custom-CLI message wrapping, `harnessOutcome()`'s
`"spawn_error"` classification, and `advanceReview`'s `!result.success` → `setBlocked(...,
"harness-failure")` branch — already handles it correctly. No new branch or blocked-state code is
needed; the fix is confined to the one uncovered throw site.

### Why catch narrowly around `spawnImpl`, not the whole executor

Wrapping the entire executor body would risk swallowing genuine programming errors from the many
listeners/timers set up afterward and muddy the single-settle invariant. The only synchronous
throw that can escape today is from the `spawnImpl` construction call; catching exactly there
keeps the change surgical and the failure classification precise (`spawn_error`).

### NUL-byte marker (resolves the issue's open question)

When `err` is the NUL-byte case (an `ERR_INVALID_ARG_VALUE` whose message mentions null bytes),
prepend a fixed, greppable marker — `NUL byte (U+0000) detected in harness argv payload` — to the
captured `stderr`. We do **not** echo the raw NUL byte into logs: a literal `\0` corrupts terminal
output and is not reliably greppable, and the marker plus Node's own "must be a string without
null bytes" message already give the operator the defect class and locus (the harness argv /
reviewed payload). Detection keys off `err.code === "ERR_INVALID_ARG_VALUE"` combined with a
message test for null bytes, so a non-NUL `ERR_INVALID_ARG_VALUE` still resolves as a generic
`spawn_error` without the NUL marker.

## Test strategy

Two complementary regression tests, both using the existing seams so no real network/subprocess is
required for the unit-level assertion:

1. **Injected `spawnFn` throwing synchronously** — pass `opts.spawnFn` that throws a
   `TypeError` with `code: "ERR_INVALID_ARG_VALUE"` and a null-byte message; assert `runCapped`
   *resolves* (does not reject) a result with `spawn_error === true`, `success === false`, and a
   `stderr` containing the NUL marker. Prove it bites: without the `try/catch`, the call throws.
2. **Real NUL byte through `invoke()`** — call `invoke("<some-cli>", cwd, prompt)` with a prompt
   containing `"\0"`; assert it resolves a `spawn_error` result rather than throwing. This
   exercises the actual `spawn()` argv rejection path end-to-end (no fake), guarding against a
   future refactor that bypasses the injected seam.

A higher-level assertion (optional, if an `advanceReview` dep-seam test is cheap) confirms the
resulting `spawn_error` result drives `setBlocked(..., "harness-failure")` — but the existing
`advanceReview` `!result.success` test already covers that branch, so the new tests focus on the
uncovered `runCapped` throw site.
