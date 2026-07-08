## Why

`runCapped` in `harness.ts` only handles harness spawn failures that arrive **asynchronously**,
via `child.on("error")` (ENOENT, missing execute permission, etc.). But `node:child_process`
`spawn()` also throws **synchronously** for certain argv contents — most notably a `TypeError
[ERR_INVALID_ARG_VALUE]` when any argument string contains a NUL byte (`U+0000`). The reviewer
prompt is assembled from the reviewed diff/source and passed as a positional argv argument, so a
NUL byte anywhere in the reviewed content reaches `spawn()` as `args[N]`.

That synchronous throw is not wrapped. It escapes the `new Promise` executor inside `runCapped`,
which rejects the promise. No caller on the reviewer path (`invoke` → `invokeReviewer` →
`invokePromptHarnessReview` → `advanceReview`) expects a rejection there — they all consume a
`HarnessResult` — so the rejection propagates as an unhandled error and crashes the entire
pipeline process. The stage is left mid-flight with no label change: the operator sees a raw
`ERR_INVALID_ARG_VALUE` stack trace and a dead run, with no blocked label and no captured cause.

The blocking path for a *failed* spawn already exists and is correct: `advanceReview` treats any
`HarnessResult` with `success: false` (including `spawn_error: true`) as a blocked outcome via
`setBlocked(...)`, and `invoke()` already maps async spawn failures to `spawn_error` results. The
only gap is that a **synchronous** `spawn()` throw never becomes a `HarnessResult` at all. Closing
that gap — catching the synchronous throw in `runCapped` and resolving a `spawn_error` result —
routes NUL-byte payloads (and any other synchronous spawn error) through the existing, proven
blocked-state machinery instead of crashing.

## What Changes

- `runCapped` wraps the `spawnImpl(cmd, args, …)` call in a `try/catch`. A synchronous throw is
  converted into a resolved `HarnessResult` with `success: false`, `spawn_error: true`,
  `exit_code: -1`, `timed_out: false`, and a `stderr` that preserves the underlying error message
  (which, for the NUL-byte case, already states the argument "must be a string without null
  bytes"). The promise **resolves** — it never rejects — so no caller ever sees a thrown error.
- When the synchronous throw is the NUL-byte case (`ERR_INVALID_ARG_VALUE` with a null-byte
  message), `runCapped` prepends an explicit, greppable marker (e.g. `NUL byte (U+0000) detected
  in harness argv payload`) to the captured `stderr` so the blocked-state evidence identifies the
  defect class without echoing the raw NUL byte into logs.
- No change is needed to `invoke()`'s custom-reviewer `spawn_error` message wrapping or to
  `advanceReview`'s `!result.success` → `setBlocked(..., "harness-failure")` branch: the new
  `spawn_error` result flows through both unchanged, reaching a blocked state with the error
  captured.
- The reviewed source is **not** sanitized: the NUL byte is surfaced as a reviewable defect via
  the blocked-state message, never silently stripped from the content under review.

## Impact

- `core/scripts/harness.ts` — `runCapped()`: wrap the spawn call in `try/catch`; add NUL-byte
  detection to the resulting `stderr`.
- `core/test/harness.test.ts` (or a co-located `*.test.ts`) — regression tests using the injected
  `spawnFn` seam and a real NUL-byte argv end-to-end assertion.
- `plugin/` mirror — regenerated after the `core/` change.
- Modifies the `harness-descendant-cleanup` capability, which already owns `runCapped`'s
  "resolve unconditionally / never crash the process" robustness contract and its injectable
  `spawnFn` seam.

## Acceptance Criteria

- [ ] When the diff/prompt payload assembled for the reviewer contains a NUL byte (`U+0000`),
  `runCapped`/`invoke` does NOT throw an unhandled `ERR_INVALID_ARG_VALUE` and does NOT exit the
  process; the returned promise resolves with a `HarnessResult`.
- [ ] The resolved `HarnessResult` for a synchronous spawn throw has `success: false` and
  `spawn_error: true`, so `advanceReview` routes it to a blocked state (`pipeline:blocked` /
  `setBlocked(..., "harness-failure")`) rather than leaving the stage mid-flight with no label
  change.
- [ ] The blocked state's recorded message includes enough detail to identify the NUL-byte defect
  (an explicit "NUL byte (U+0000) detected …" marker plus the underlying spawn error text), not a
  generic failure message, and does NOT echo the raw NUL byte into the log stream.
- [ ] Any other synchronous `spawn()` throw (e.g. an invalid-argv error that is not the NUL case)
  is likewise caught and resolved as a `spawn_error` `HarnessResult`, not a process crash; the
  existing async `child.on("error")` handling for ENOENT / permission errors is unchanged.
- [ ] The reviewed source content is not mutated or NUL-stripped by the pipeline; the NUL byte is
  reported through the blocked state, leaving the review free to flag it as a defect.
- [ ] After the fix, re-running the pipeline on the same issue/PR (independently of the NUL byte
  being removed from source) proceeds normally past the review stage when the payload is clean.
- [ ] A regression test constructs a spawn that throws synchronously (a real NUL-byte argv and/or
  an injected `spawnFn` that throws `ERR_INVALID_ARG_VALUE`) and asserts `runCapped`/`invoke`
  resolves a `spawn_error` result with the NUL detail captured — never a thrown/uncaught
  exception. The test SHALL bite: without the `try/catch` it throws/rejects rather than passing.

## Out of Scope

- Blocked-state recovery/retry behavior in general (tracked under #391).
- Sanitizing or stripping NUL bytes from the source under review.
- Hardening every other subprocess spawn across the codebase beyond the harness/`runCapped` path.
