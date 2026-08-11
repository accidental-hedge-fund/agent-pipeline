## Why

Every efficiency fix in this milestone is one careless refactor away from silently
regressing. The pipeline already emits `gh_metrics_summary` telemetry
(median ~83 `gh` calls / ~63 s `gh` time per advance from 274 audited runs) and
already has injectable stage deps seams, but nothing asserts a call budget in
`npm test`. This change makes the `gh` call budget a first-class regression
signal so the audit does not need to be repeated after each cache or memo win.

## What Changes

- Extend `GhMetricsCollector` / `gh_metrics_summary` so per-run call counts are
  broken down by typed wrapper name (e.g. `getPrDetail`, `getPrChecks`), not
  only as a single aggregate `call_count` and CLI `category` strings.
- Pin explicit unit-test budget ceilings (named constants with comments stating
  which regression each ceiling catches) for:
  - **Pre-merge poll path:** with stubbed `getPrChecks` returning `pending` for
    N ticks under a shared `PreMergePollingContext`, total deps-invocation count
    stays at or below the pinned ceiling (and fails if the entry-gate head memo
    from #816 is removed).
  - **Full advance walk:** a deterministic injectable full-stage walk stays at
    or below its own pinned ceiling.
- Assertions run inside `npm test` via existing deps seams
  (`AdvanceReviewDeps`, `ShaGateDeps`, `VerifyDeps`, `PreMergePollingContext`,
  pre-merge deps) with **no real network, git, or subprocess** calls.
- **Out of scope (follow-up #1002):** reconcile-cycle budget assertion (needs
  reconcile fan-out from #822 / v1.53.0 track).

## Acceptance criteria

- [ ] `gh_metrics_summary` (or the collector `summary()` it is built from) exposes
      per-run call counts broken down by typed wrapper name, in addition to the
      existing aggregate fields.
- [ ] A unit test drives the pre-merge poll path with injectable deps and stubbed
      `getPrChecks` returning pending for a fixed N ticks; total deps-invocation
      count is asserted `<=` a named constant ceiling.
- [ ] That pre-merge budget test fails if the entry-gate head memo skip path is
      removed (i.e. the ceiling is low enough that full per-tick entry-gate work
      exceeds it).
- [ ] A unit test drives a full advance walk with injectable deps and asserts
      total deps-invocation count `<=` a second named constant ceiling.
- [ ] Each ceiling is an explicit named constant with a comment that states which
      regression it catches; raising a ceiling is a deliberate, reviewable edit.
- [ ] All new assertions run under `npm test` with no real network, git, or
      subprocess calls.
- [ ] Reconcile-cycle budget is **not** asserted in this change (tracked as #1002).
- [ ] No review step, gate, reviewer invocation, or CI policy is removed or
      demoted.
- [ ] `openspec validate gh-call-budget-regression-gate` passes; after
      implementation, `npm run ci` is green and `plugin/` is regenerated if
      mirrored `core/` sources change.

## Capabilities

### New Capabilities

- `gh-call-budget-regression-gate`: Unit-test regression gates that pin maximum
  injectable deps-invocation counts for the pre-merge multi-tick poll path and a
  full advance walk, using explicit named ceilings that fail when amortization
  (entry-gate memo) or other efficiency work is silently lost.

### Modified Capabilities

- `gh-call-metrics`: Extend the per-run metrics collector and
  `gh_metrics_summary` event so call counts are available broken down by typed
  wrapper name, without dropping existing aggregate fields or secret-safety rules.

## Impact

- **Core metrics:** `core/scripts/gh.ts` (`GhMetricsCollector`, summary shape),
  `core/scripts/run-store.ts` (`GhMetricsSummaryEvent` / emit path).
- **Tests:** New or extended tests under `core/test/` (e.g. `gh-metrics.test.ts`,
  `pre-merge-entry-gate-head-anchor.test.ts` or a dedicated budget test file)
  counting deps invocations only — no real I/O.
- **Living specs:** New capability delta + modified `gh-call-metrics`.
- **Depends on:** #816 entry-gate memo (merged) — the pre-merge ceiling is
  calibrated so removing that memo fails the budget test.
- **Companion / train:** #838 instrumentation/cache work may land in the same
  PR train; this change asserts budgets rather than implementing new caches.
- **Out of scope:** Reconcile-cycle budget (#1002); runtime hard-fails on
  production `gh` budgets; changing gate policy or merge authority; auto-merge.
- **Not changing:** Advance never merges; review rigor; single-host lock scope.
