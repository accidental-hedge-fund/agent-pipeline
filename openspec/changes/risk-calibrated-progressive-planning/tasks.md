## 1. Inventory evidence prerequisites

- [ ] 1.1 Inventory host-local / scoreboard coverage for #702 planning-leverage, assumption-lineage, and material-rework events (depths, risk classes, sample sizes by window).
- [ ] 1.2 Inventory #576 production-outcome join coverage and observed vs inferred authority mix for the same windows.
- [ ] 1.3 Record evidence-sufficiency gaps (classes with n≈0) in the research note draft without inventing rates.

## 2. Research note — classes and routing

- [ ] 2.1 Create durable research note path (prefer `docs/research/risk-calibrated-progressive-planning.md`; create `docs/research/` if absent, else `docs/risk-calibrated-progressive-planning.md`).
- [ ] 2.2 Define candidate work/risk classes with stable ids, allowed evidence sources, and non-assignment cases (ambiguity, reversibility, blast_radius, novelty, dependency_uncertainty, security_compliance, observed_rework_cost, unknown).
- [ ] 2.3 Publish closed routing-action vocabulary and class×evidence → action mapping table with most-restrictive composition and `preserve_assumptions` stacking rules.
- [ ] 2.4 Document escalation boundaries and safe defaults for missing, conflicting, and high-severity incomplete evidence.
- [ ] 2.5 Document human-authority boundaries (irreversible, high blast, security, compliance) and explicit distinction from agent plan-review / feedback window.
- [ ] 2.6 Map actions to recommended `planning_depth` ∈ `minimal|standard|deep|unknown` without new depth enum values.
- [ ] 2.7 Link the research note from `docs/concepts.md` (or equivalent operator entry point).

## 3. Offline evaluation design

- [ ] 3.1 Author offline evaluation design (section or sibling doc) covering joins, primary outcomes, cohort keys, sample-size reporting, and associational labeling.
- [ ] 3.2 Define operational false-positive (over-planning) and false-negative (under-planning) metrics and a time-window calibration loop.
- [ ] 3.3 List banned proxy-only success metrics (plan length, planning wall time alone, token spend alone) and required primary outcome set.
- [ ] 3.4 Define evidence-sufficiency checklist that must be recorded before any future staged-policy promotion toward `observe`/`enforcing`.

## 4. Spec lock and staged-policy placement

- [ ] 4.1 Confirm OpenSpec deltas remain consistent with the research note (actions, defaults, human-authority, automation gate).
- [ ] 4.2 Document future staged policy id (e.g. `progressive_planning_depth`) as `draft`/`observe` only; verify no config ships `enforcing` progressive routing.
- [ ] 4.3 Verify assumption-lineage carry-forward requirements for lightweight paths are reflected in research note + specs.

## 5. Optional pure offline helpers (only if needed)

- [ ] 5.1 If offline fixtures need code: add pure recommendation composition helpers (most-restrictive action, safe defaults) under a dedicated module with injected fixtures — no advance-loop wiring.
- [ ] 5.2 Unit tests: closed action enum; conflict → restrictive; security incomplete → not lightweight; preserve_assumptions stacks; recommended depth enum closed; no collapsed score field.
- [ ] 5.3 If no helpers: document that evaluation is manual/scripted from existing scoreboard/events and skip 5.1–5.2 with a note in the research package.

## 6. Validation and non-goals check

- [ ] 6.1 Run `openspec validate risk-calibrated-progressive-planning` (and `openspec validate --all` in CI path) until green.
- [ ] 6.2 If any `core/` files changed: `node scripts/build.mjs` and commit regenerated `plugin/` in the same change set.
- [ ] 6.3 Run `npm run ci` from repo root until green when code or docs-gated paths change.
- [ ] 6.4 Confirm non-goals: no automated planning-depth routing in advance/loop; no single opaque risk score; no merge-authority change; no review-rigor demotion; longer planning time not treated as success.
