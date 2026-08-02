## 1. Engine-class rate + scoreboard integrity

- [x] 1.1 Change `computeFrgEvidence` so `engine_class_rate = engine_class_count / item_count` when `item_count ≥ 1` (never `null`); empty pack never release-eligible
- [x] 1.2 Count each pack item at most once; terminal projected class only; multi-event recovery does not multi-count
- [x] 1.3 Parse validation: finite numbers only; when `item_count ≥ 1` require rate in `[0,1]` and rate === count/item_count; counts match `per_item` tallies; `item_count === per_item.length`
- [x] 1.4 Update `formatFrgPrSection` / CLI so rate never prints `n/a` when `item_count ≥ 1`
- [x] 1.5 Unit tests: clean → 0; mixed item_count denom; above threshold fails; NaN/Infinity rejected; zero items not release-eligible; prior null/n/a path gone

## 2. Composition evidence + single release-eligibility validator

- [x] 2.1 Add `composition` (+ optional `recovery_aggregates`, `integrity`) to `FrgEvidence` with frozen dimension id list from design Decision 5
- [x] 2.2 Extend `isReleaseEligibleFrgPass` / export `validateReleaseEligibleFrgEvidence(raw, expectedVersion)` as the single strict gate used by compute, parse, lookup, and auto-tag
- [x] 2.3 Enforce all required composition dimensions pass; clean-only packs fail with `missing[]` naming each gap; false_human_authority_count must be 0
- [x] 2.4 Project composition from ledger where possible; accept schema-validated observation file for the rest
- [x] 2.5 Integrity fingerprints recomputed on validate; minimal forged `pass: true` fails
- [x] 2.6 Unit tests: forged/incomplete pass; wrong-version; missing provenance; malformed JSON; clean-only; each missing composition dimension; false human_authority

## 3. Recovery aggregates + #787 controller exercise

- [x] 3.1 Document and require controller entry via `pipeline single` (one-item) and `pipeline loop` (multi-item) composition dimensions
- [x] 3.2 Map injected classes to `DEFAULT_RECOVERY_POLICY` retry budgets / terminal outcomes (design Decision 7)
- [x] 3.3 Optional `recovery_aggregates.by_reason` on evidence + ledger when available from pack run
- [x] 3.4 Terminal engine-owned exhaustion → engine-class item classification (existing taxonomy)
- [x] 3.5 Unit tests: missing one-item or multi-item dimension fails; false human_authority fails; aggregate projection with fakes

## 4. Trend ledger

- [x] 4.1 Append-only `.agent-pipeline/frg/trend-ledger.jsonl` after successful primary evidence write
- [x] 4.2 Idempotency key `(version, run_id)`; duplicate append no-ops
- [x] 4.3 Fields per design Decision 6; thresholds snapshot; recovery aggregates when present
- [x] 4.4 Fail-soft ledger I/O after primary write (report, do not delete evidence)
- [x] 4.5 Unit tests: append, multi-release history, duplicate key, fail-soft

## 5. Scenario / composition observation CLI

- [x] 5.1 `--observations <file>` on `pipeline factory-gate` (+ optional repeated `--scenario`); help/usage updated
- [x] 5.2 Schema-validate observation file; reject unknown/missing required ids; map to overrides
- [x] 5.3 Keep `frgRequiredObservationOverrides` test-only
- [x] 5.4 Unit/CLI parse tests

## 6. Auto-tag FRG guard + committed evidence

- [x] 6.1 Workflow step after version match + tag-not-exists, before tag create/push: invoke shared Node validator on `.agent-pipeline/frg/<version>/latest.json` with detected version
- [x] 6.2 Fail closed on missing/unparsable/not release-eligible; non-release and existing-tag no-ops unchanged
- [x] 6.3 Drift-guard tests: FRG step present **and ordered before** tag push; removing fails test; existing-tag and non-release covered
- [x] 6.4 Runbook: evidence must be committed on release PR (`.agent-pipeline/frg/` is not gitignored)

## 7. Layer A waivers (full inventory — only two waivers)

- [x] 7.1 `release-plan-row` (#730 CLOSED): land hermetic/drift test (prefer auto-tag FRG honesty) or retarget open issue; remove closed-only citation
- [x] 7.2 `pr-supersession` (#729 CLOSED): same rule — test preferred or open-issue retarget
- [x] 7.3 Assert inventory remains only these waived scenarios; runbook table matches `FRG_LAYER_A_WAIVERS`

## 8. Runbook and fixture migration

- [x] 8.1 Update `docs/factory-reliability-gate-runbook.md`: rate formula, bootstrap K/25%, trend ledger semantics, composition minimums + dimension table, observation CLI schema, controller entry points + policy bounds, auto-tag dependency on **committed** evidence, integrity notes
- [x] 8.2 Retire #749/#750-class clean-only fixtures as non-representative
- [x] 8.3 Align docs/cli.md factory-gate section with new flags

## 9. Mirror, CI, and verification

- [x] 9.1 After `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/`
- [x] 9.2 `npm run ci` green from repo root
- [x] 9.3 `openspec validate frg-representative-pack-requirements` (and `--all` when archiving)
- [x] 9.4 Do **not** change numeric K or `max_engine_class_rate` defaults
- [x] 9.5 No auto-merge path; FRG still never tags as a side effect of scoring
