## 1. Config surface

- [ ] 1.1 Add optional `review_ensemble` to `PartialConfigSchema` / resolved config with `.describe()` on every field (`enabled` default false, `agents`, `min_usable_agents` default 1, `max_agents` cap, optional timeout)
- [ ] 1.2 Resolve `role: primary` to configured reviewer (`review_harness` / `harnesses.reviewer` + model/effort); accept additional `{ harness, model?, effort? }` agents
- [ ] 1.3 Reject invalid configs (enabled + empty agents, empty harness strings, over max agents, unknown merge mode if present); unit-test schema and resolve paths
- [ ] 1.4 Document the opt-in block in init template / config reference surfaces with default-off comment

## 2. Pure merge helper

- [ ] 2.1 Implement pure `mergeEnsembleVerdicts` (or equivalent) that unions findings and dedupes by `findingKey` from `review-policy.ts`
- [ ] 2.2 Apply deterministic same-key field merge: max `severityRank`, max confidence, title/body/location from severity winner with confidence then config-order tie-break
- [ ] 2.3 Compute top-level merged verdict without majority-vote approve (any findings → needs-attention path into existing partition; all approve+empty → approve)
- [ ] 2.4 Unit tests: union-only finding kept; same-key dedupe; max severity/confidence; blocking from either agent; all-approve empty; deterministic ties; no real I/O

## 3. Ensemble orchestration at the reviewer seam

- [ ] 3.1 Add ensemble orchestration wrapper around (or beside) `invokeReviewer` that no-ops to single-agent when ensemble disabled
- [ ] 3.2 Resolve agent list, invoke each agent concurrently (`Promise.allSettled` or equivalent) against same worktree and shared prompt material (optional identity suffix only)
- [ ] 3.3 Apply per-agent #39 self-review fallback independently; collect usable vs failed with failure classes (spawn_error, timeout, nonzero, unparseable)
- [ ] 3.4 Soft-fail when `usable >= min_usable_agents` (merge + diagnostics); fail-closed when below threshold (never silent approve)
- [ ] 3.5 Wire plan-review, review-1, and review-2 (and SHA-gate re-review via shared seam) to consume the ensemble result object

## 4. Single disposition + persistence + scoreboard

- [ ] 4.1 Format/post one review comment/artifact per round with merged findings and multi-agent identity; disclose self-review when any agent fell back
- [ ] 4.2 Persist additive ensemble fields on the round inside `events.jsonl` / `summary.json` (agents[], size, usable/failed, merge summary); finding array = merged set with `findingKey` keys
- [ ] 4.3 Ensure fix / ceiling / override / settled-surface / SHA-gate consumers still see one finding set / blocking-key set
- [ ] 4.4 Update scoreboard aggregation to sum per-agent costs, expose ensemble size, and count self-review per agent when ensemble fields are present; leave single-agent runs valid

## 5. Tests, mirror, and gate

- [ ] 5.1 Orchestration unit tests with injected invoke fakes: concurrent call count, partial failure soft-fail, all-fail fail-closed, per-agent self-review labeling, disabled path single invoke — no network/git/subprocess
- [ ] 5.2 Regression: existing single-reviewer / self-review / partitionFindings tests still pass with ensemble off
- [ ] 5.3 Regenerate `plugin/` via `node scripts/build.mjs` after any `core/` change; commit mirror with core
- [ ] 5.4 Run `npm run ci` green (including `openspec validate --all`)
