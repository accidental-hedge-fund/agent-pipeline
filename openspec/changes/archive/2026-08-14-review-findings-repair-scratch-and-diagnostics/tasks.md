## 1. Default policy and migration

- [x] 1.1 Change `DEFAULT_RECOVERY_POLICY["review-findings"].recipes` to `["unlink_engine_scratch", "repair_pipeline_item"]` in `core/scripts/loop/recovery.ts` (keep `retry_budget: 3`, `repeated_evidence_limit: 2`).
- [x] 1.2 Add the **exact** pre-#1060 repair-only default to `STALE_DEFAULT_POLICY_ENTRIES["review-findings"]` (recipes, budgets, backoff, terminal, run_fatal — see design D5).
- [x] 1.3 Unit tests: default recipe order; exact stale migrates; custom repair-only-with-different-budget preserved; unrelated custom classes preserved (`loop-recovery.test.ts`).

## 2. Unlink prep semantics for review-findings (class-scoped)

- [x] 2.1 Extend `unlink_engine_scratch` in `pipeline.ts` so class `review-findings` unlinks engine-known scratch when present, **never** clears `pipeline:blocked`, **never** returns `succeeded: true` as findings recovery, and returns prep-complete / not-applicable fall-through evidence (shared classifier only; product dirt fail-closed).
- [x] 2.2 Preserve terminal scratch-only success for `workflow-engine-defect` (unlink + clear blocked when scratch-only, no harness round, sibling filer).
- [x] 2.3 Keep product-dirt and no-scratch paths fail-closed / try-next-recipe without false recover.

## 3. Same-sequence controller semantics and budget accounting

- [x] 3.1 Supervisor / recovery start: preparatory `unlink_engine_scratch` under `review-findings` does **not** decrement `recovery_budgets_remaining` and does **not** burn repeated-evidence as a repair failure.
- [x] 3.2 After prep-complete or no-scratch not-applicable, **same `executeBlockedRecovery` cycle** claims and runs `repair_pipeline_item` (when candidate head exists and repair budget remains).
- [x] 3.3 When no engine-known scratch at claim time, skip unlink claim and go straight to `repair_pipeline_item` (default policy order still lists unlink first under test).
- [x] 3.4 Regression: three repair budget units remain available for implementer repair after free prep (scratch present and no-scratch paths).

## 4. Single scratch-cleanup boundary + repair failure diagnostics

- [x] 4.1 **Authoritative boundary only:** do **not** add best-effort engine-scratch strip inside `repair_pipeline_item`. Residual porcelain after prep → dirt-blocked evidence, not silent delete.
- [x] 4.2 Build typed non-`fix-committed` evidence: `status`, `category` (`noop-clean` \| `dirt-blocked` \| `harness-error` \| `no-diagnostic`), and bounded diagnostic tail or explicit absence (`repair-pipeline-item.ts`; propagate autofix/harness diagnostics including pre-dirty).
- [x] 4.3 Dirt-blocked uses shared porcelain classifier (`classifyPorcelainForScratchRecover` / `worktree-dirt.ts`); path summary; product dirt fail-closed; no broad `artifacts/**` waiver.
- [x] 4.4 Ensure evidence/error is what supervisor stores on `loop_recovery_action_executed` and `completeRecoveryAttempt` (no silent collapse).
- [x] 4.5 Do not mislabel committed-but-unpushed, harness crash, or bare pre-dirty error as `noop-clean`.

## 5. Regression tests (#599 shape)

- [x] 5.1 Policy order: default `review-findings` places `unlink_engine_scratch` before `repair_pipeline_item`.
- [x] 5.2 Fixture: findings + `artifacts/challenge-response-*.json` → unlink executed before repair; repair observes no remaining engine-known scratch; blocked not cleared by unlink alone.
- [x] 5.3 Fixture: no engine scratch → still reaches `repair_pipeline_item` same sequence / within budget (no dead-end, no false recover).
- [x] 5.4 Fixture: prep does not charge findings retry budget (budget after prep+failed repair still allows remaining attempts per `retry_budget`).
- [x] 5.5 Fixture: repair no-commit with harness output → evidence includes status + category + tail (not generic-only).
- [x] 5.6 Fixture: `noop-clean` explicit no-change + diagnostic.
- [x] 5.7 Fixture: dirt-blocked residual product dirt (and residual engine scratch if prep skipped) → dirt-blocked category + path summary.
- [x] 5.8 Fixture: no captured diagnostic → evidence states absence.
- [x] 5.9 Confirm `workflow-engine-defect` scratch-only terminal path and product-dirt fail-closed still pass.
- [x] 5.10 Stale-default migration + custom-policy preservation tests (1.3).
- [x] 5.11 Injected deps only (no real network/git/subprocess) in unit tests.

## 6. Spec deltas, mirror, validate, CI

- [x] 6.1 Align delta specs with D2–D5 (same-sequence free prep, typed evidence survival, single cleanup boundary) if not already complete.
- [x] 6.2 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 6.3 Run `openspec validate review-findings-repair-scratch-and-diagnostics` and `openspec validate --all` until clean.
- [x] 6.4 Run `npm run ci` from the repo root until green.
