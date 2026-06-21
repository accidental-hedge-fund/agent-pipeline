## 1. Add `getHeadCheckRunCount` to `gh.ts`

- [ ] 1.1 Export `getHeadCheckRunCount(cfg, sha): Promise<number>` that calls
  `gh api repos/{repo}/commits/{sha}/check-runs --jq .total_count` via `ghRun`
  and returns the parsed integer.
- [ ] 1.2 Unit test in `gh.test.ts`: fake `ghRun` returns `"3\n"` → resolves 3;
  fake returns `"0\n"` → resolves 0; fake throws → propagates.

## 2. Add `ci_no_run_grace_s` to config

- [ ] 2.1 Add `ci_no_run_grace_s: number` (default `60`) to `PipelineConfig` in
  `config.ts`; document it alongside `ci_timeout`.
- [ ] 2.2 Validate that `ci_no_run_grace_s` is non-negative in `validateConfig`.

## 3. Add `closePr` / `reopenPr` helpers to `gh.ts`

- [ ] 3.1 Export `closePr(cfg, prNumber): Promise<void>` wrapping `gh pr close`.
- [ ] 3.2 Export `reopenPr(cfg, prNumber): Promise<void>` wrapping `gh pr reopen`.
- [ ] 3.3 Unit tests for both helpers (fake `ghRun` stub; verify correct args).

## 4. Extend `AdvancePreMergeDeps` with no-run deps

- [ ] 4.1 Add optional dep fields to the deps interface:
  `getHeadCheckRunCount`, `closePr`, `reopenPr`.
- [ ] 4.2 Wire production defaults in `advancePreMerge`.

## 5. Capture pre-archive SHA in `advancePreMerge`

- [ ] 5.1 Before calling `maybeArchiveOpenspec`, fetch `prDetail.headRefOid` (already
  available in the `prDetail` fetch done for conflict detection) and store it as
  `preArchiveSha`.
- [ ] 5.2 Pass `preArchiveSha` into the CI-gate sub-path.

## 6. Implement no-run detection and recovery in the CI-gate path

- [ ] 6.1 After `getPrChecksFn` returns `agg.pending`, check elapsed time since
  polling started for this iteration. If elapsed ≥ `cfg.ci_no_run_grace_s * 1000`,
  call `getHeadCheckRunCountFn(cfg, prDetail.headRefOid)`.
- [ ] 6.2 If count > 0, return `waiting` as before (runs exist, just pending).
- [ ] 6.3 If count === 0:
  - Fetch the archive diff file paths (via `gh pr diff --name-only` on
    `preArchiveSha..HEAD` or equivalent).
  - If diff is openspec-only AND `getHeadCheckRunCount(preArchiveSha)` > 0:
    call `closePrFn` then `reopenPrFn`, return `waiting`.
  - Otherwise: surface actionable error, call `setBlockedFn` with `needs-human`
    and message "no CI run detected for head SHA; try closing and reopening the PR".

## 7. Tests

- [ ] 7.1 `pre_merge.test.ts` — no-run recovery (archive-only diff + prior SHA green):
  fake `getHeadCheckRunCount` returns 0 for head, positive for pre-archive SHA;
  fake diff is openspec-only → `closePr` and `reopenPr` called; returns `waiting`.
- [ ] 7.2 `pre_merge.test.ts` — no-run, non-archive diff:
  fake `getHeadCheckRunCount` returns 0; diff includes non-openspec files →
  `setBlocked` called with `needs-human`; `closePr` NOT called.
- [ ] 7.3 `pre_merge.test.ts` — normal pending (runs exist, count > 0):
  fake `getHeadCheckRunCount` returns 2 → stays `waiting`; no close+reopen.
- [ ] 7.4 `pre_merge.test.ts` — normal case unaffected:
  `agg.pending = false, agg.passed = true` → advances; no zero-run check invoked.

## 8. Mirror + CI

- [ ] 8.1 `node scripts/build.mjs` — regenerate `plugin/` mirror.
- [ ] 8.2 `npm run ci` green.
