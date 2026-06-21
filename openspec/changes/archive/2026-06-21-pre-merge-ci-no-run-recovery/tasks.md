## 1. Add `getHeadCheckRunCount` to `gh.ts`

- [x] 1.1 Export `getHeadCheckRunCount(cfg, sha): Promise<number>` that calls
  `gh api repos/{repo}/commits/{sha}/check-runs --jq .total_count` via `ghRun`
  and returns the parsed integer.
- [x] 1.2 Unit test in `gh.test.ts`: fake `ghRun` returns `"3\n"` → resolves 3;
  fake returns `"0\n"` → resolves 0; fake throws → propagates.

## 2. Add `ci_no_run_grace_s` to config

- [x] 2.1 Add `ci_no_run_grace_s: number` (default `60`) to `PipelineConfig` in
  `config.ts`; document it alongside `ci_timeout`.
- [x] 2.2 Validate that `ci_no_run_grace_s` is non-negative in `validateConfig`.

## 3. Add `closePr` / `reopenPr` helpers to `gh.ts`

- [x] 3.1 Export `closePr(cfg, prNumber): Promise<void>` wrapping `gh pr close`.
- [x] 3.2 Export `reopenPr(cfg, prNumber): Promise<void>` wrapping `gh pr reopen`.
- [x] 3.3 Unit tests for both helpers (fake `ghRun` stub; verify correct args).

## 4. Extend `AdvancePreMergeDeps` with no-run deps

- [x] 4.1 Add optional dep fields to the deps interface:
  `getHeadCheckRunCount`, `getSuccessfulCheckRunCount`, `closePr`, `reopenPr`.
- [x] 4.2 Wire production defaults in `advancePreMerge`.
- [x] 4.3 Add a `PreMergePollingContext` interface with three fields:
  `ciGateEnteredAt?: number` (wall-clock ms when CI gate first observed pending checks),
  `noRunRecoveryAttemptedForSha?: string` (head SHA for which close+reopen was already tried),
  and `preArchiveSha?: string` (PR head before the OpenSpec archive commit). All three
  fields are allocated once in `advancePolling` and threaded via `opts.pollingCtx` so
  they persist across successive `advance()` calls within the same polling session.

## 5. Capture pre-archive SHA in `advancePreMerge`

- [x] 5.1 Before calling `maybeArchiveOpenspec`, fetch `prDetail.headRefOid` (already
  available in the `prDetail` fetch done for conflict detection) and store it as
  `preArchiveSha`.
- [x] 5.2 Pass `preArchiveSha` into the CI-gate sub-path.

## 6. Implement no-run detection and recovery in the CI-gate path

- [x] 6.1 After `getPrChecksFn` returns `agg.pending`, check elapsed time since the
  first CI-pending observation in the current polling session (persisted in
  `pollingCtx.ciGateEnteredAt` across all `advance()` calls; set on first entry,
  never reset within the session). If elapsed ≥ `cfg.ci_no_run_grace_s * 1000`,
  call `getHeadCheckRunCountFn(cfg, prDetail.head_sha)`.
  NOTE: the check must use `=== undefined` (not falsy) to guard the first-write,
  because `0` (epoch) is a valid timestamp and falsy in JavaScript.
- [x] 6.2 If count > 0, return `waiting` as before (runs exist, just pending).
- [x] 6.3 If count === 0:
  - If `noRunRecoveryAttemptedForSha` equals the current head SHA, skip
    close+reopen and call `setBlockedFn` with `needs-human` and message
    "no CI run detected for head SHA <sha> after recovery was already attempted".
  - Otherwise, fetch the archive diff file paths (via `gh pr diff --name-only` on
    `preArchiveSha..HEAD` or equivalent).
  - If diff is openspec-only AND `getSuccessfulCheckRunCount(preArchiveSha)` > 0
    (at least one successful check-run — failed/pending runs do not qualify):
    set `noRunRecoveryAttemptedForSha` to the current head SHA, call `closePrFn`
    then `reopenPrFn`, return `waiting`.
  - Otherwise: surface actionable error, call `setBlockedFn` with `needs-human`
    and message "no CI run detected for head SHA; try closing and reopening the PR".

## 7. Tests

- [x] 7.1 `pre-merge-no-run-recovery.test.ts` — no-run recovery (archive-only diff + prior SHA green):
  fake `getHeadCheckRunCount` returns 0 for head; `getSuccessfulCheckRunCount` returns positive
  for pre-archive SHA; fake diff is openspec-only → `closePr` and `reopenPr` called; returns `waiting`.
- [x] 7.2 `pre-merge-no-run-recovery.test.ts` — no-run, non-archive diff:
  fake `getHeadCheckRunCount` returns 0; diff includes non-openspec files →
  `setBlocked` called with `needs-human`; `closePr` NOT called.
- [x] 7.3 `pre-merge-no-run-recovery.test.ts` — normal pending (runs exist, count > 0):
  fake `getHeadCheckRunCount` returns 2 → stays `waiting`; no close+reopen.
- [x] 7.4 `pre-merge-no-run-recovery.test.ts` — normal case unaffected:
  `agg.pending = false, agg.passed = true` → advances; no zero-run check invoked.
- [x] 7.5 `pre-merge-no-run-recovery.test.ts` — second zero-count poll for the same head SHA (regression):
  simulate two successive `advance` calls with `getHeadCheckRunCount` returning 0
  both times; assert that `closePr` and `reopenPr` are each called exactly once,
  and the second call returns `{ status: "blocked" }` with `setBlocked` invoked.
- [x] 7.6 `pre-merge-no-run-recovery.test.ts` — archive-only diff but prior SHA has only failed runs:
  `getSuccessfulCheckRunCount` returns 0 for pre-archive SHA → `closePr` NOT called;
  `setBlocked` called with actionable message. Regression for spec-divergence finding.

## 8. Mirror + CI

- [x] 8.1 `node scripts/build.mjs` — regenerate `plugin/` mirror.
- [x] 8.2 `npm run ci` green.
