## 1. Merge-surface retry seam

- [x] 1.1 Inventory `mergePr` / `checkMergeability` and existing UNKNOWN tests in `core/test/merge.test.ts` (and any train merge fixtures that assume immediate UNKNOWN throw).
- [x] 1.2 Export named constants in `core/scripts/stages/merge.ts`:
  - `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS = 5` (total reads; initial counts)
  - `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS = 5000`
- [x] 1.3 Add `sleep(ms: number): Promise<void>` to `MergeDeps`; production `realMergeDeps` uses real timer; tests inject no-wait recorder.
- [x] 1.4 Implement bounded UNKNOWN re-read loop in `mergePr` only when `mergeable === "UNKNOWN"`:
  - re-fetch `mergeable`, `mergeStateStatus`, `headRefOid` each attempt
  - sleep only between UNKNOWN attempts (`MAX-1` sleeps max)
  - proceed only on MERGEABLE+CLEAN from the **latest** read
  - bind `--match-head-commit` to **that** successful `headRefOid` (never the UNKNOWN-read SHA)
  - hard unclean states (CONFLICTING, DIRTY, BEHIND, BLOCKED, HAS_HOOKS, MERGEABLE+non-CLEAN, etc.) refuse immediately with zero sleeps
- [x] 1.5 Log each UNKNOWN retry at info level; after budget exhaustion throw existing actionable UNKNOWN message class and never call `gh pr merge`.

## 2. Train inheritance (no train-local mole)

- [x] 2.1 Confirm train `mergeIssuePr` continues to call shared `mergePr` only; do not add a train-only UNKNOWN string-matcher recoverer.
- [x] 2.2 Confirm post-budget UNKNOWN and hard gate failures still surface as `merge failed for #…` train STOP with non-zero exit.

## 3. Tests

- [x] 3.1 Unit: UNKNOWN → MERGEABLE+CLEAN on 2nd read → exactly 2 mergeability `ghPrView`s, 1 sleep(5000), 1 `ghPrMerge` with **second** read’s `headRefOid`.
- [x] 3.2 Unit: persistent UNKNOWN through full budget → exactly 5 reads, 4 sleeps(5000), actionable UNKNOWN refuse, zero `ghPrMerge`.
- [x] 3.3 Unit: first-read CONFLICTING → 1 read, 0 sleeps, refuse, no merge.
- [x] 3.4 Unit: first-read MERGEABLE+DIRTY → 1 read, 0 sleeps, refuse, no merge.
- [x] 3.5 Unit: UNKNOWN is never treated as MERGEABLE (no merge while latest classification is UNKNOWN).
- [x] 3.6 Train/hermetic via **real** `mergePr` (not mocked success `mergeIssuePr`): wire `mergeIssuePr: (pr) => mergePr(pr, mergeDeps)` with injected UNKNOWN then MERGEABLE+CLEAN sequence + fake sleep; assert merge, containment, train continues; no first-attempt #1059-class STOP text.
- [x] 3.7 Regression: #1059-class first-attempt terminal text is illegal when in-budget success path applies (test fails if reintroduced).
- [x] 3.8 Update existing `merge: unknown mergeability — refuses and does not merge` to budget-exhaust semantics (or split transient-success vs exhaust).
- [x] 3.9 All new tests use deps injection only (no real network, git, subprocess, or wall-clock sleep). Default test `makeDeps` supplies no-wait `sleep`.

## 4. Mirror, validate, CI

- [x] 4.1 After `core/` edits: `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 4.2 `openspec validate train-retry-unknown-mergeability` (and full `openspec validate --all` via `npm run ci`).
- [x] 4.3 `npm run ci` green from repo root — required before done (no suite-pass claim without this).
