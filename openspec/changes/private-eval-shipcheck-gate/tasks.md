## 1. Config schema extension

- [ ] 1.1 Add `ShipcheckGateConfig` zod sub-schema to `core/scripts/config.ts` with fields: `enabled`, `mode`, `max_rounds`, `rubric_path`, `block_on_partial`
- [ ] 1.2 Add `shipcheck_gate` key to `PartialConfigSchema` (strict, optional)
- [ ] 1.3 Extend `DEFAULT_CONFIG` with `shipcheck_gate: { enabled: false, mode: "advisory", max_rounds: 1, rubric_path: ".github/shipcheck-rubric.md", block_on_partial: false }`
- [ ] 1.4 Update `PipelineConfig` type to include `shipcheck_gate` field

## 2. Stage constant and dispatch

- [ ] 2.1 Insert `"shipcheck-gate"` into `STAGES` in `core/scripts/types.ts` between `"eval-gate"` and `"ready-to-deploy"`
- [ ] 2.2 Add `"shipcheck-gate"` to the orchestrator dispatch table in `core/scripts/pipeline.ts` pointing to the new stage handler

## 3. Shipcheck verdict schema

- [ ] 3.1 Add `ShipcheckVerdict` schema (`verdict`, `summary`, `criteria`) to `core/scripts/review-schema.ts`
- [ ] 3.2 Export `SHIPCHECK_VERDICT_SCHEMA_BLOCK` constant alongside existing `REVIEW_VERDICT_SCHEMA_BLOCK`
- [ ] 3.3 Add a drift-guard assertion in the existing schema constant test that covers `SHIPCHECK_VERDICT_SCHEMA_BLOCK`

## 4. Shipcheck prompt template

- [ ] 4.1 Create `core/scripts/prompts/shipcheck.md` with placeholders: `{{rubric}}`, `{{issue_body}}`, `{{plan_and_acs}}`, `{{changed_files}}`, `{{eval_summary}}`, `{{openspec_deltas}}`, `{{schema_block}}`
- [ ] 4.2 Write a `buildShipcheckPrompt(opts)` function in `core/scripts/stages/shipcheck.ts` that loads the rubric file, assembles context from available sources, and substitutes all placeholders

## 5. Stage handler core logic

- [ ] 5.1 Create `core/scripts/stages/shipcheck.ts` with `advance(cfg, issueNumber, deps)` handler
- [ ] 5.2 Implement skip-when-disabled path (transition to `ready-to-deploy` with log, no harness call)
- [ ] 5.3 Implement rubric-load logic: read from `rubric_path`; fallback to issue AC section (with warning) when file absent
- [ ] 5.4 Implement reviewer harness invocation loop (up to `max_rounds`) calling `cfg.harnesses.reviewer` with the shipcheck prompt
- [ ] 5.5 Implement `parseShipcheckVerdict` that attempts JSON extraction from fenced block then inline object, conservative fallback to `{ verdict: "fail", summary: raw }` with warning logged
- [ ] 5.6 Implement advisory-mode routing: post comment, then always transition to `ready-to-deploy`
- [ ] 5.7 Implement gate-mode routing: `pass` → transition; `fail` → `setBlocked`; `partial` → block only if `block_on_partial` is true
- [ ] 5.8 Implement timeout/parse-failure handling: gate mode → `setBlocked` with `needs-human`; advisory mode → warn and advance

## 6. Result posting

- [ ] 6.1 Implement `formatShipcheckComment(verdict, mode)` that produces a PR/issue comment with: labeled header ("Shipcheck (advisory)" or "Shipcheck"), overall verdict, summary, and per-criterion table
- [ ] 6.2 Post the comment to the issue (and PR when `pr` is non-null) before any transition or block call

## 7. Unit tests

- [ ] 7.1 Create `core/test/shipcheck.test.ts` with a `ShipcheckDeps` seam (gh, harness, rubric reader fakes)
- [ ] 7.2 Test: disabled gate skips (no harness call, transitions to ready-to-deploy)
- [ ] 7.3 Test: rubric file absent — fallback to issue body, warning logged
- [ ] 7.4 Test: advisory mode with fail verdict still advances
- [ ] 7.5 Test: gate mode with pass verdict advances
- [ ] 7.6 Test: gate mode with fail verdict blocks
- [ ] 7.7 Test: gate mode with partial verdict + `block_on_partial: false` advances
- [ ] 7.8 Test: gate mode with partial verdict + `block_on_partial: true` blocks
- [ ] 7.9 Test: unparseable output in gate mode → needs-human block after max_rounds
- [ ] 7.10 Test: unparseable output in advisory mode → warn and advance
- [ ] 7.11 Test: `buildShipcheckPrompt` substitutes all placeholders including absent eval summary fallback text
- [ ] 7.12 Test: `SHIPCHECK_VERDICT_SCHEMA_BLOCK` drift-guard passes (schema constant matches embedded string)

## 8. Config tests

- [ ] 8.1 Add test: `shipcheck_gate` block absent → `enabled: false`, all defaults applied
- [ ] 8.2 Add test: `shipcheck_gate` with valid keys accepted, values propagated
- [ ] 8.3 Add test: unknown key under `shipcheck_gate:` rejected at parse time

## 9. Mirror regeneration and CI

- [ ] 9.1 Run `node scripts/build.mjs` to regenerate `plugin/` mirror
- [ ] 9.2 Run `npm run ci` from repo root and confirm all checks pass
