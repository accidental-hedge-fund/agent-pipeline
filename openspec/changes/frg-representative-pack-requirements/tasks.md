## 1. Engine-class rate formula

- [ ] 1.1 Change `computeFrgEvidence` so `engine_class_rate = engine_class_count / item_count` when `item_count ≥ 1`, else leave non-release-eligible / incomplete (never `null` for non-empty packs)
- [ ] 1.2 Update `formatFrgPrSection` / CLI stdout so rate never prints `n/a` when `item_count ≥ 1` (numeric percent, including `0.0%`)
- [ ] 1.3 Adjust evidence parse validation to require numeric `engine_class_rate` in `[0, 1]` whenever `item_count ≥ 1`
- [ ] 1.4 Unit tests: clean pack → rate `0`; mixed pack uses item_count denominator; rate above threshold fails; regression that prior `null`/`n/a` path is gone

## 2. Representative pack composition validation

- [ ] 2.1 Define composition evidence shape on FRG evidence (scenario ids and/or `composition` object): OpenSpec-bearing, fix→re-review, concurrency N≥2, recovery classes, controller one-item + multi-item
- [ ] 2.2 Enforce composition checks inside release-eligibility (`isReleaseEligibleFrgPass` / equivalent) so clean-only packs fail even when K is met
- [ ] 2.3 Project composition signals from ledger where possible; accept structured observation CLI for the rest
- [ ] 2.4 Unit tests: clean-only fixture fails with named missing dimensions; full representative fixture can pass when other criteria met; false `human_authority` projection fails

## 3. Recovery aggregates and #787 controller exercise

- [ ] 3.1 Extend scoreboard and/or evidence with recovery aggregates (success, exhaustion, resumes, elapsed by canonical reason code) when available from the pack run
- [ ] 3.2 Wire terminal engine-owned exhaustion into engine-class item classification (existing taxonomy)
- [ ] 3.3 Document and require one-item + multi-item recovery-controller entry in composition validation
- [ ] 3.4 Unit tests for aggregate projection and false human-authority rejection (hermetic fakes)

## 4. Trend ledger

- [ ] 4.1 Implement append-only write to `.agent-pipeline/frg/trend-ledger.jsonl` (or documented path) on durable evidence write
- [ ] 4.2 Include version, run_id, loop_run_id, pass, pack_id, created_at, item/ready/engine counts, rate, thresholds, recovery aggregates
- [ ] 4.3 Fail-soft: ledger I/O error after primary evidence write reports but does not delete evidence
- [ ] 4.4 Unit tests with injected fs deps for append, multi-release history, and fail-soft path

## 5. Scenario observation CLI

- [ ] 5.1 Add documented CLI surface on `pipeline factory-gate` (`--observations <file>` and/or repeated `--scenario` flags)
- [ ] 5.2 Parse into `scenarioOverrides`; validate schema; wire through `runFactoryGate`
- [ ] 5.3 Keep `frgRequiredObservationOverrides` test-only (not operator default for release pass)
- [ ] 5.4 Unit/CLI parse tests; usage string and help text updated

## 6. Auto-tag FRG guard

- [ ] 6.1 Add workflow step in `auto-tag-release.yml` after version match / tag-not-exists, before tag create/push: load and validate FRG evidence for the version
- [ ] 6.2 Prefer shared Node validate entry (reuse parse/release-eligibility) over re-expressing rules in bash
- [ ] 6.3 Fail closed (non-zero, no tag) on missing/invalid/`pass: false`; non-release path unchanged
- [ ] 6.4 Drift-guard tests: FRG step present before tag push; removing it fails the test

## 7. Layer A waivers and hermetic coverage

- [ ] 7.1 Refresh `release-plan-row` waiver: land hermetic/drift-guard test or retarget to open tracking issue (no closed #730 citation)
- [ ] 7.2 Audit waiver table for any other closed-issue-only citations and refresh
- [ ] 7.3 Add/adjust hermetic tests for new composition or recovery classes that fit fake-deps seams; explicit open-issue waivers for the rest

## 8. Runbook and fixture migration

- [ ] 8.1 Update `docs/factory-reliability-gate-runbook.md`: rate formula, bootstrap K/25% note, trend ledger, composition minimums, observation CLI, recovery controller exercise, auto-tag FRG dependency on committed evidence
- [ ] 8.2 Document retirement of #749/#750-class clean-only fixtures as non-representative
- [ ] 8.3 Align runbook scenario inventory / waiver table with code and Layer A state

## 9. Mirror, CI, and verification

- [ ] 9.1 After all `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/`
- [ ] 9.2 `npm run ci` green from repo root
- [ ] 9.3 Confirm `openspec validate frg-representative-pack-requirements` (and `--all` when archiving later)
- [ ] 9.4 Do **not** change numeric K or `max_engine_class_rate` defaults in this change
