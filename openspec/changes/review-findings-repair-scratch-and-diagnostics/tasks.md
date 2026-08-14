## 1. Default policy and migration

- [ ] 1.1 Change `DEFAULT_RECOVERY_POLICY["review-findings"].recipes` to `["unlink_engine_scratch", "repair_pipeline_item"]` in `core/scripts/loop/recovery.ts` (keep existing budgets unless D3 requires a documented adjustment).
- [ ] 1.2 Add the pre-#1060 repair-only default to `STALE_DEFAULT_POLICY_ENTRIES["review-findings"]` so `upgradeContractForRecovery` migrates exact stale defaults.
- [ ] 1.3 Update unit assertions that snapshot `DEFAULT_RECOVERY_POLICY["review-findings"]` (e.g. `loop-recovery.test.ts`) for the new recipe order and migration.

## 2. Unlink prep semantics for review-findings

- [ ] 2.1 Extend `unlink_engine_scratch` so class `review-findings` unlinks engine-known scratch when present, does **not** clear `pipeline:blocked` as successful findings recovery, and returns a not-success fall-through / try-next-recipe outcome with explicit evidence.
- [ ] 2.2 Preserve terminal scratch-only success for `workflow-engine-defect` (unlink + clear blocked when scratch-only, no harness round).
- [ ] 2.3 Keep product-dirt and no-scratch paths fail-closed / try-next-recipe without false recover.
- [ ] 2.4 Implement D3 mitigation so no-scratch findings recovery still reaches `repair_pipeline_item` within budget (skip unlink when no scratch and/or best-effort prep unlink inside repair).

## 3. Repair failure diagnostics

- [ ] 3.1 Propagate non-`fix-committed` status and diagnostic/harness output from the shared autofix / harness-round result into `repair_pipeline_item` failure evidence.
- [ ] 3.2 Distinguish at least: implementer `noop-clean`, dirt/porcelain-blocked commit or pre-dirty refusal (with path summary when available), and harness/error with bounded output tail; never collapse all of these to only the generic “did not produce a committed and pushed repair” string when status/diagnostic exist.
- [ ] 3.3 Bound/redact tails consistently with existing harness log practices.

## 4. Regression tests (#599 shape)

- [ ] 4.1 Policy order test: default `review-findings` recipes place `unlink_engine_scratch` before `repair_pipeline_item`.
- [ ] 4.2 Fixture: `review-findings` + `artifacts/challenge-response-*.json` present → unlink claimed before repair; repair observes clean engine-scratch porcelain (injectable deps, no real git/network/subprocess).
- [ ] 4.3 Fixture: unlink under `review-findings` does not clear blocked / does not mark substantive recovery success while findings still apply.
- [ ] 4.4 Fixture: no engine scratch → recovery still claims `repair_pipeline_item` within budget.
- [ ] 4.5 Fixture: repair completes without commit but with harness/diagnostic output → error/evidence includes status + tail (not generic-only).
- [ ] 4.6 Fixture: `noop-clean` still surfaces the explicit implementer no-change message + diagnostic.
- [ ] 4.7 Confirm existing `workflow-engine-defect` unlink-before-repair and scratch-only composition tests still pass.
- [ ] 4.8 Stale-default migration test for `review-findings` repair-only → new default.

## 5. Mirror, validate, CI

- [ ] 5.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 5.2 Run `openspec validate review-findings-repair-scratch-and-diagnostics` (and `openspec validate --all` as needed) until clean.
- [ ] 5.3 Run `npm run ci` from the repo root and fix failures until green.
