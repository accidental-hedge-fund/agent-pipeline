## 1. Catch the synchronous spawn throw in `runCapped`

- [x] 1.1 In `core/scripts/harness.ts`, wrap the `spawnImpl(cmd, args, { … })` call in a
  `try/catch` (narrowly around the construction call only, not the whole Promise executor).
- [x] 1.2 On catch, compute `duration = (Date.now() - start) / 1000` and `settle`/resolve a
  terminal `HarnessResult`: `{ success: false, stdout: "", stderr: <marker>+"[harness <label>]
  spawn error: "+err.message, exit_code: -1, duration, timed_out: false, spawn_error: true }`.
  The promise MUST resolve, never reject.
- [x] 1.3 NUL-byte detection: when `err.code === "ERR_INVALID_ARG_VALUE"` and the message
  indicates a null byte, prepend the fixed marker `NUL byte (U+0000) detected in harness argv
  payload\n` to `stderr`. For any other synchronous throw, omit the marker (generic
  `spawn_error`). Do NOT echo the raw NUL byte.
- [x] 1.4 Ensure the `catch` short-circuits before any listeners/timers that assume a live
  `child` are attached (i.e. return/resolve immediately from the catch).

## 2. Confirm downstream blocked path is unchanged

- [x] 2.1 Verify (read-only) that `invoke()`'s custom-CLI `spawn_error` message wrapping and
  `harnessOutcome()`'s `"spawn_error"` classification still apply to the new result — no code
  change expected.
- [x] 2.2 Verify (read-only) that `advanceReview`'s `!result.success` branch calls
  `setBlocked(cfg, issueNumber, <detailMsg with stderr excerpt>, stage, "harness-failure")` — no
  code change expected; the NUL detail rides in via `formatStderrExcerpt(result.stderr)`.

## 3. Regression tests

- [x] 3.1 Injected-seam test: call `runCapped` with `opts.spawnFn` that throws a `TypeError`
  (`code: "ERR_INVALID_ARG_VALUE"`, null-byte message); assert the returned promise RESOLVES with
  `spawn_error === true`, `success === false`, `timed_out === false`, and `stderr` containing the
  `NUL byte (U+0000)` marker.
- [x] 3.2 Non-NUL synchronous throw: inject a `spawnFn` throwing a generic error; assert a
  resolved `spawn_error` result WITHOUT the NUL marker (generic path).
- [x] 3.3 Real-NUL end-to-end: call `invoke("<cli>", cwd, promptWithNul)` where `promptWithNul`
  contains `"\0"`; assert it resolves a `spawn_error` result and does not throw. (Exercises the
  real `spawn()` argv rejection, not the injected seam.)
- [x] 3.4 Prove the tests bite: temporarily remove the `try/catch` from 1.1, run the suite,
  confirm 3.1/3.3 throw/reject (fail), then restore.

## 4. Mirror + CI

- [x] 4.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror.
- [x] 4.2 `npm run ci` green end-to-end from the repo root.
