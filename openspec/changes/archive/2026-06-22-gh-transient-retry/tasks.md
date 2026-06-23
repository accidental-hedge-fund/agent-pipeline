## 1. isTransientGhError pure function

- [x] 1.1 Add exported `isTransientGhError(stderr: string): boolean` to `core/scripts/gh.ts` that returns `true` for HTTP 401 "bad credentials", HTTP 403 rate-limit, HTTP 5xx (500/502/503/504), and ETIMEDOUT/ECONNRESET/ENOTFOUND/socket-hang-up patterns; returns `false` for all other inputs (404, 422, "not found", "validation failed", unrecognized).
- [x] 1.2 Case-insensitive matching throughout — the function SHALL normalise `stderr` to lowercase before pattern checks.

## 2. GhRunOptions seam additions

- [x] 2.1 Add `sleep?: (ms: number) => Promise<void>` to the `GhRunOptions` interface in `core/scripts/gh.ts`.
- [x] 2.2 Add `isTransient?: (stderr: string) => boolean` to the `GhRunOptions` interface in `core/scripts/gh.ts`.

## 3. ghRun retry loop update

- [x] 3.1 In `ghRun`, replace the `if (stderr.toLowerCase().includes("rate limit") && attempt < retries - 1)` branch with: `if ((opts.isTransient ?? isTransientGhError)(combinedStderr) && attempt < retries - 1)`.
- [x] 3.2 Use `combinedStderr` = `(e.stderr ?? "").toString() || e.message` as the string passed to the predicate so that network-level errors (which appear in `e.message`, not `e.stderr`) are also classified correctly.
- [x] 3.3 Replace the hardcoded `new Promise((r) => setTimeout(r, backoff))` with `(opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(backoff)` so tests can skip real delays.

## 4. Unit tests

- [x] 4.1 Unit test `isTransientGhError` directly: verify each transient class returns `true` (401 bad credentials, 403 rate limit, 502, ETIMEDOUT, ECONNRESET) and each deterministic class returns `false` (404, 422, unknown string). Prove the test bites (fails without the function or with an empty implementation).
- [x] 4.2 Unit test: fake `ghRun` deps where runner fails with 401 stderr on attempt 1, succeeds on attempt 2; assert the call returns successfully and exactly 2 invocations occurred.
- [x] 4.3 Unit test: fake deps where runner always returns 404 stderr; assert the call throws after exactly 1 invocation and `sleep` spy is never called.
- [x] 4.4 Unit test: fake deps where runner always returns a 5xx stderr with `retries: 2`; assert the call throws after exactly 2 invocations and `sleep` spy is called exactly once (between attempt 1 and 2).
- [x] 4.5 Unit test: `isTransient` override in `GhRunOptions` is honoured — a custom predicate that always returns `false` prevents any retry even on a 401 stderr.

## 5. Mirror + CI

- [x] 5.1 Run `node scripts/build.mjs` to regenerate the `plugin/` mirror.
- [x] 5.2 Run `npm run ci` from repo root; all checks green.
