## 1. Open-list completeness in `getPrForIssue`

- [x] 1.1 Confirm the chosen complete-enumeration transport against real `gh` output (paginated REST pulls, multi-page `pr list`, or equivalent) — field names for `number`, `headRefName`, `isCrossRepository`, and `closingIssuesReferences` (or map into that shape).
- [x] 1.2 Replace the hard `gh pr list ... -L 100` open scan in `getPrForIssue` with complete open-candidate enumeration (paginate until exhausted or proven-complete equivalent) that still feeds `parsePrList` + `resolvePrForIssue` (or an equivalent dual-strategy path that preserves branch-prefix and closing-ref rules).
- [x] 1.3 Add an optional injectable runner / list dep (default production `ghRun`), mirroring `getPrForIssueAnyState`, so tests need no real network.
- [x] 1.4 Ensure a safety page bound either is far above realistic open-PR volume or fails visibly if hit mid-list — never silent `null` after truncation.
- [x] 1.5 Preserve dual-strategy order and fork/cross-repo rules; do not reintroduce body/title matching or per-PR `gh pr view` fan-out for resolution.

## 2. Regression tests

- [x] 2.1 Add a unit test: matching open PR only on a later page / outside a 100-item window → `getPrForIssue` returns that PR (injected multi-page list deps).
- [x] 2.2 Add a unit test: exhausted open pages with no match → `null`.
- [x] 2.3 Keep existing dual-strategy / parser tests green (`resolvePrForIssue`, `parsePrList`, fork spoof, cross-repo closing refs).
- [x] 2.4 Prove bite: temporarily restore single-page `-L 100` (or stop after page 1) and confirm the new regression test fails.

## 3. Ship

- [x] 3.1 Run `node scripts/build.mjs` and include regenerated `plugin/` if `core/` changed.
- [x] 3.2 Run `npm run ci` from repo root until green.
