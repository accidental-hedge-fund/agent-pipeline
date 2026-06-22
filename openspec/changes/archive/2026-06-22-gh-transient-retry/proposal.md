## Why

A transient HTTP 401 (or 5xx / network blip) on any `gh` call crashes the entire pipeline run and strands the issue mid-stage. The `ghRun` function currently retries only on `"rate limit"` text in stderr; all other transient error classes — including a momentary 401 on the GitHub GraphQL endpoint (observed live during issue #255) — throw immediately with no recovery path.

## What Changes

- `ghRun` (`core/scripts/gh.ts`): replace the narrow `rate limit` text-match retry predicate with a call to a new exported `isTransientGhError(stderr)` pure function that classifies a broader set of transient error classes (HTTP 401/403, 5xx, network/timeout) while explicitly passing deterministic failures through immediately.
- `GhRunOptions`: add two optional test-injection fields — `sleep` (injectable delay function) and `isTransient` (injectable classification predicate) — so unit tests can exercise the retry loop directly without spawning a real subprocess.
- `core/test/gh.test.ts`: add regression tests that prove the retry path fires on transient errors and that deterministic errors bypass it entirely.

## Capabilities

### New Capabilities
- `gh-transient-retry`: `ghRun` SHALL retry transient gh API failures with exponential backoff; `isTransientGhError` classifies which error classes qualify; retry seams are injectable for testing.

### Modified Capabilities
- (none — the current rate-limit retry behavior is absorbed into the new `isTransientGhError` predicate with no external behavior change for callers who already hit rate-limit errors)

## Impact

- `core/scripts/gh.ts` — `GhRunOptions` type, `ghRun` function body, new exported `isTransientGhError` function.
- `core/test/gh.test.ts` — new unit tests for transient retry and deterministic pass-through.
- `plugin/` mirror (regenerated; no hand-edits).
- No changes to callers of `ghRun`, to `GhApiRunner` seams, or to any stage files.

## Acceptance Criteria

- [ ] `isTransientGhError` is exported from `gh.ts` and returns `true` for at least: a "Bad credentials" 401 body, a rate-limit 403 body, any 5xx status in stderr, and ETIMEDOUT/ECONNRESET network errors.
- [ ] `isTransientGhError` returns `false` for: 404 / "not found" / validation / "unprocessable" errors.
- [ ] A unit test simulates a fake `gh` that fails with a transient 401 stderr on attempt 1 and succeeds on attempt 2; the call returns successfully without throwing.
- [ ] A unit test simulates a fake `gh` that always returns a 404 stderr; the call throws after exactly 1 attempt (no retries consumed).
- [ ] A unit test simulates a fake `gh` that always returns a transient error; the call throws after exactly `retries` attempts (bounded budget exhausted).
- [ ] The injectable `sleep` and `isTransient` seams in `GhRunOptions` are used by the tests above to avoid real delays or real subprocess spawning.
- [ ] `npm run ci` passes end-to-end with no regressions.
