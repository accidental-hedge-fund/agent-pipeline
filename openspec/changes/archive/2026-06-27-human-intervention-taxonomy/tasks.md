## 1. Core Module

- [ ] 1.1 Create `core/scripts/intervention.ts` with `HumanInterventionKind` string union (all 11 members including `"unknown"`)
- [ ] 1.2 Define `HumanInterventionEvent` interface matching the documented payload shape (`schema_version`, `type`, `at`, `kind`, `stage`, `issue`, `detail`, `ref`)
- [ ] 1.3 Implement `emitHumanIntervention(deps, payload)` — constructs the event, applies write-time injection denylist, appends to `events.jsonl` via `appendEvent`, catches and warns on failure
- [ ] 1.4 Add optional `kind?: HumanInterventionKind` field to `OverrideRecord` type in the evidence-bundle types

## 2. Stage Wiring

- [ ] 2.1 Wire `emitHumanIntervention` in `planning.ts` for ambiguous-issue and product-judgment-required exits
- [ ] 2.2 Wire `emitHumanIntervention` in `review.ts` for review ceiling / `needs-human` transitions (`review-non-convergence`) and reviewer-unavailable fallback
- [ ] 2.3 Wire `emitHumanIntervention` in `fix.ts` for test/build-failure exhaustion exits (`test-build-failure`)
- [ ] 2.4 Wire `emitHumanIntervention` in `pre_merge.ts` for merge-conflict and branch-drift blocks (`merge-conflict-or-branch-drift`)
- [ ] 2.5 Wire `emitHumanIntervention` in `eval.ts` / `deploy_ready.ts` for eval/shipcheck failures (`eval-shipcheck-failure`)
- [ ] 2.6 Wire `emitHumanIntervention` in the override recording path (`human-risk-override`) and set `kind` on the `OverrideRecord`
- [ ] 2.7 Wire `emitHumanIntervention` in `auto_recover.ts` or doctor-preflight path for auth/tooling/preflight failures (`auth-tooling-preflight-failure`)

## 3. Summary Aggregation

- [ ] 3.1 Implement `InterventionSummary` interface (`total`, `byKind`, `items`)
- [ ] 3.2 Implement `summarizeInterventions(events, windowMs?)` pure helper: filter by type, apply window, zero-initialize all known kinds, count, handle unknown kind strings under `"unknown"`
- [ ] 3.3 Add `interventions` array to `finalizeRun()` output in `summary.json` (collect all `human_intervention` events from the run's `events.jsonl` at finalization)
- [ ] 3.4 Add `--interventions` flag to the `improve` subcommand: read events, call `summarizeInterventions`, print JSON to stdout

## 4. Tests

- [ ] 4.1 Unit test `HumanInterventionKind` enum: all members serialize to expected strings; no duplicates
- [ ] 4.2 Unit test `emitHumanIntervention`: valid payload produces correct event; I/O failure is caught and warned; injection denylist is applied to `detail` and `ref`
- [ ] 4.3 Unit test `summarizeInterventions`: correct counts for each kind; window filter; empty input; unrecognized kind counted under `"unknown"`
- [ ] 4.4 Regression test: each stage wiring call produces a `human_intervention` event with the correct kind (inject fake `appendEvent` deps, exercise the stage exit path)
- [ ] 4.5 Unit test `improve --interventions`: outputs valid JSON with `total`, `byKind`, `items`; exits 0 on empty run directory
- [ ] 4.6 Verify all new tests fail without the implementation (prove test bites)

## 5. Mirror and CI

- [ ] 5.1 Run `node scripts/build.mjs` to regenerate `plugin/` mirror after all core changes
- [ ] 5.2 Run `npm run ci` from repo root and confirm all checks pass (ci:core → build.mjs --check → ci:install-smoke)
- [ ] 5.3 Verify `openspec validate human-intervention-taxonomy` passes before committing
