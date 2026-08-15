## 1. Merge-surface retry seam

- [ ] 1.1 Inventory `mergePr` / `checkMergeability` and existing UNKNOWN tests in `core/test/merge.test.ts` (and any train merge fixtures that assume immediate UNKNOWN throw).
- [ ] 1.2 Add injectable delay on `MergeDeps` (e.g. `sleep(ms)`) with production default real timer and test fakes; define named attempt budget + delay constants in the band ~5 attempts / ~5–15s.
- [ ] 1.3 Implement bounded UNKNOWN re-read loop in `mergePr`: re-fetch `mergeable`, `mergeStateStatus`, and `headRefOid` each attempt; sleep only between UNKNOWN attempts; proceed only on MERGEABLE+CLEAN from the latest read; bind `--match-head-commit` to that head.
- [ ] 1.4 Keep CONFLICTING / DIRTY / BEHIND / BLOCKED / HAS_HOOKS / other non-clean states as immediate hard refusals (no success via UNKNOWN budget).
- [ ] 1.5 Log each UNKNOWN retry attempt at info level; after budget exhaustion throw/return the existing actionable UNKNOWN message class and never call `gh pr merge`.

## 2. Train inheritance (no train-local mole)

- [ ] 2.1 Confirm train `mergeIssuePr` continues to call shared `mergePr` only; do not add a train-only UNKNOWN string-matcher recoverer.
- [ ] 2.2 Confirm post-budget UNKNOWN and hard gate failures still surface as `merge failed for #…` train STOP with non-zero exit.

## 3. Tests

- [ ] 3.1 Unit: first `ghPrView` UNKNOWN, second MERGEABLE+CLEAN (+ other gates pass) → `mergePr` succeeds; assert ≥2 mergeability reads, sleep called, merge invoked once.
- [ ] 3.2 Unit: all reads UNKNOWN through budget → refuse; no `gh pr merge`; error names UNKNOWN.
- [ ] 3.3 Unit: CONFLICTING on first read → refuse without merge; no UNKNOWN success path.
- [ ] 3.4 Unit: UNKNOWN is never treated as MERGEABLE (no merge while latest classification is UNKNOWN).
- [ ] 3.5 Train/hermetic: first mergeability UNKNOWN then MERGEABLE+CLEAN under `train --merge` → item merges and train continues; no first-attempt STOP of the #1059 20:04Z class.
- [ ] 3.6 Regression: #1059-class first-attempt terminal text is illegal when in-budget success path applies (test fails if reintroduced).
- [ ] 3.7 Update existing `merge: unknown mergeability — refuses and does not merge` (and any similar) to match budget-exhausted behavior or split into transient-success vs exhaust cases.
- [ ] 3.8 All new tests use deps injection only (no real network, git, subprocess, or wall-clock sleep).

## 4. Mirror, validate, CI

- [ ] 4.1 After `core/` edits: `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 4.2 `openspec validate train-retry-unknown-mergeability` (and full `openspec validate --all` via `npm run ci`).
- [ ] 4.3 `npm run ci` green from repo root.
