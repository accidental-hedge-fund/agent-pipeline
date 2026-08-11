## 1. Collector and event shape (`by_wrapper`)

- [ ] 1.1 Extend `GhMetricsCollector` / `GhMetricsSummary` in `core/scripts/gh.ts` so `record` accepts an optional typed wrapper name and `summary()` returns additive `by_wrapper` counts (omit untagged calls from the map; keep existing aggregates and `slowest_calls.category`)
- [ ] 1.2 Extend `GhMetricsSummaryEvent` and `emitGhMetrics` in `core/scripts/run-store.ts` to include `by_wrapper` without dropping existing fields or secret-safety rules
- [ ] 1.3 Thread wrapper name from public typed helpers into the metrics path via `GhRunOptions` (or equivalent) for at least the load-bearing pre-merge/advance helpers (`getPrDetail`, `getPrChecks`, `getPrForIssue`, `getIssueDetail`, and other helpers that stage deps commonly invoke)
- [ ] 1.4 Add unit tests in `core/test/gh-metrics.test.ts` (and run-store emit tests if needed) covering: independent wrapper counts, aggregate inclusion of untagged calls, empty `by_wrapper` on zero records, event payload includes `by_wrapper`, no raw args in keys

## 2. Pre-merge poll budget regression

- [ ] 2.1 Add a named constant `PRE_MERGE_POLL_DEPS_CEILING` (or equivalent) with a comment that it catches entry-gate head-memo regression / redundant per-tick entry work
- [ ] 2.2 Implement or extend a multi-tick pending-CI unit test (injectable deps, shared `PreMergePollingContext`, `getPrChecks` pending for N ≥ 10, unchanged head) that sums deps invocations and asserts `total <= PRE_MERGE_POLL_DEPS_CEILING`
- [ ] 2.3 Calibrate the ceiling against the current #816 memo-enabled baseline so the memo path passes and a full per-tick entry-stack cost for the same fixture exceeds the ceiling
- [ ] 2.4 Add a proving assertion or paired test that documents/enforces “full stack every tick > ceiling” so removing the memo skip path fails `npm test`

## 3. Full advance walk budget regression

- [ ] 3.1 Add a named constant `ADVANCE_WALK_DEPS_CEILING` (or equivalent) with a comment that it catches silent reintroduction of redundant GitHub reads on the advance path
- [ ] 3.2 Implement a deterministic full advance walk unit test with injectable deps only that sums deps invocations and asserts `total <= ADVANCE_WALK_DEPS_CEILING`
- [ ] 3.3 Calibrate the ceiling from the current green baseline for that fixture set (tight enough to catch obvious regressions; raise only via deliberate constant edit)

## 4. Verify and land

- [ ] 4.1 Confirm no production path hard-fails solely on unit-test budget constants; no review/CI/merge policy demotions; no reconcile-cycle budget in this change (#1002)
- [ ] 4.2 If mirrored `core/` sources changed, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit
- [ ] 4.3 Run focused tests for metrics + budget cases, then `npm run ci` from repo root until green
- [ ] 4.4 Run `openspec validate gh-call-budget-regression-gate` (and `openspec validate --all` as part of ci) until green
