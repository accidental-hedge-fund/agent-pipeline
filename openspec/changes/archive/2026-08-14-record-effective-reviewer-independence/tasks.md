## 1. Types, lineage map, and pure coverage helpers

- [x] 1.1 Add typed structures for attempt lineage, coverage counts, cost coverage classes, and the closed aggregation outcome enum (aligned with `review-ensemble` identity types).
- [x] 1.2 Implement deterministic `provider_family` / `model_family` mapping from harness + model identifiers (including `unknown`) with unit tests for known harnesses and unknown fallback.
- [x] 1.3 Implement pure independence eligibility + independent count (`lineage_key` uniqueness, self-review and implementer harness excluded).
- [x] 1.4 Implement pure aggregation-outcome classifier for all five outcomes with reason strings; unit-test complete, partial_quorum, same_lineage_fallback, quorum_unmet, no_usable_reviewers boundaries.
- [x] 1.5 Implement pure `required` resolution from optional `min_independent_by_risk` + structured risk class input (default required 0).

## 2. Config schema

- [x] 2.1 Extend `review_ensemble` schema with optional `min_independent_by_risk`, optional substitute agent list, and optional `allow_quorum_degrade` (default false); reject negatives.
- [x] 2.2 Update init/template exhaustive coverage for new fields (commented defaults).
- [x] 2.3 Add config unit tests: omit map → inert; high:2 accepted; negative rejected; ensemble disabled still resolves.

## 3. Ensemble / reviewer seam integration

- [x] 3.1 On each agent attempt in `review-ensemble` (and single-reviewer path), populate lineage, latency, cost class, failure/fallback reason.
- [x] 3.2 After first wave, compute counts + outcome; if `quorum_unmet` or `no_usable_reviewers` and substitutes configured, run at most one substitute wave and recompute.
- [x] 3.3 Gate coverage-complete success: min usable alone must not clear an armed independent quorum; map zero usable to `no_usable_reviewers`.
- [x] 3.4 Preserve union-merge + findingKey dedupe; under `quorum_unmet`, retain usable agents’ findings on the merged set.
- [x] 3.5 Extend disposition comment disclosure with counts, outcome, self-review/lineage degradation (single comment still).

## 4. Persistence and accounting

- [x] 4.1 Persist additive lineage, counts, outcome, and reason on `review_verdict` / summary / ensemble meta without a new well-known run file; keep schema additive.
- [x] 4.2 Bind coverage to existing `evidence_subject` when the round already carries one (no second identity vocabulary).
- [x] 4.3 Emit stage-cost dimensions for requested / attempted / completed / billable; never invent billable $0 actual for unknown cost.
- [x] 4.4 Extend scoreboard (if it already reads ensemble meta) to surface independent/required/outcome when present.

## 5. Blockers, recipes, and escalation inventory

- [x] 5.1 Add `BlockerKind` members for independent-quorum-unmet and no-usable-reviewers with non-empty `BLOCKER_RECIPES`.
- [x] 5.2 Wire fail-closed escalation call sites to those kinds after substitute bound; default not product-judgment needs-human.
- [x] 5.3 Register both sites in the escalation-site disposition inventory (`deliberately-fail-closed` for quorum unmet; closed disposition for no-usable per design).
- [x] 5.4 Ensure recipe snapshot / exhaustiveness tests and disposition drift-guard cover the new sites.

## 6. Tests and verification

- [x] 6.1 Unit tests: provider-family overlap counts as one independent; distinct families count as two.
- [x] 6.2 Unit tests: self-review fallback labeled and never independent.
- [x] 6.3 Unit tests: timeout / partial success → partial_quorum when required met; no_usable_reviewers when all fail.
- [x] 6.4 Unit tests: quorum met vs unmet; substitute wave repairs once; second failure stays blocked.
- [x] 6.5 Unit tests: union-preserved blockers under quorum_unmet; no majority approve.
- [x] 6.6 Unit tests: cost requested/attempted/completed/billable rollups with unknown cost.
- [x] 6.7 Orchestration tests inject invoke fakes only (no real network/git/subprocess).
- [x] 6.8 Run `npm run ci` from repo root; regenerate and commit `plugin/` if any `core/` file changed.
