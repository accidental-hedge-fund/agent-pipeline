## 1. Logical-operation identity on existing run artifacts

- [ ] 1.1 Add `logical_operation_id` to `RunMeta` / `initRunDir` as a written-once opaque id distinct from `run_id`, and verify a first-init fake writes both fields and a second `initRunDir` on the same directory leaves the original logical id unchanged
- [ ] 1.2 Stamp `logical_operation_id` on `run_start` (and admission-time train/loop/merge/ship events) as an additive `schema_version` 1 field, and verify `readEvents` returns the field unchanged
- [ ] 1.3 Copy `logical_operation_id` into finalized `summary.json`, and verify `finalizeRun` on a fake store includes the same id written in `run.json`
- [ ] 1.4 Mint a new logical id only when no valid resume binding is present, and verify a new public-admission fixture without named run, loop-store id, or parent handoff receives a different `logical_operation_id` from an earlier same-issue run

## 2. Resume binding and nested-child inheritance

- [ ] 2.1 Reuse the written logical id on run-directory re-entry and operator resume of a named `run_id`, and verify a fresh-process resume fixture keeps `L` while allowing a new physical `run_id`
- [ ] 2.2 Persist parent `logical_operation_id` on nested loop-store contracts without a second ledger or lock namespace, and verify a resumed loop fake reloads `L` and does not mint a new id
- [ ] 2.3 Propagate `logical_operation_id` on `train_loop_linked` / `onRunReady` handoff using the existing #1301 linkage fields, and verify a child loop fake inherits the train identity and a duplicate handoff does not replace it
- [ ] 2.4 Treat parent-spawned `single` / pack-loop / ship-phase / attestation ticks as the same logical operation, and verify those nested fixtures do not increment unique-operation success counts by themselves

## 3. Shared unique-operation classifier

- [ ] 3.1 Add one pure aggregator (additive-section pattern, no new store or CLI verb) that deduplicates by `logical_operation_id` and classifies verified success, cooling/recovery, external wait, typed request, cancellation, false-human projection, ownerless terminal, exact-candidate recovery, independent-sibling continuation, and missing/contradictory correlation, and verify unit tests inject events/run metas/manifest only
- [ ] 3.2 Count unique-operation success at most once per `logical_operation_id`, and verify two physical runs of `L` that later prove exact-candidate completion increase numerator and denominator by 1 each
- [ ] 3.3 Treat process exit, `run_complete`, and issue closure as insufficient for verified success, and verify a zero-exit fixture without postcondition proof is not counted as unique-operation success
- [ ] 3.4 Exclude typed requests, external waits, and cancellations from clean completion only when the versioned pack manifest declares that expected outcome, and verify an undeclared wait is not a stable exclusion
- [ ] 3.5 Derive false-human counts from the existing composition / blocker-taxonomy classification rather than labels or prose, and verify a mechanical-fault fixture increments both `composition.false_human_authority_count` and the unique-operation false-human count
- [ ] 3.6 Classify ownerless terminals when none of the closed outcomes apply, and verify that fixture is not scored as success, wait, or cancellation

## 4. FRG evidence section and release gate

- [ ] 4.1 Extend `FrgEvidence` with versioned `operation_reliability` bound to candidate SHA, release identity, manifest fingerprint, entrypoint coverage, numerators, denominators, exclusions, integrity counts, and per-operation evidence refs, and verify `computeFrgEvidence` writes the section from durable fakes
- [ ] 4.2 Require `operation_reliability` for release-eligible `pass: true` and fail `validateReleaseEligibleFrgEvidence` plus factory-release prepare on unmet SLOs or integrity counts, and verify missing correlation, missing required coverage, false-human > 0, ownerless > 0, and clean-completion < 100% each refuse `pass: true`
- [ ] 4.3 Bind `operation_reliability` into the existing HMAC attestation payload, and verify mutating a unique-operation count after mint fails verification while public fingerprints stay intact
- [ ] 4.4 Fail FRG promotion when #1301 live linkage or #1333 required lifecycle coverage is absent, and verify those gaps are integrity failures rather than stable exclusions
- [ ] 4.5 Keep offline `scoreInput` without live provenance non-release-eligible even if `operation_reliability` is present, and verify the existing offline-score rejection still holds

## 5. Scoreboard and outcome consumers

- [ ] 5.1 Add an additive unique-operation section to `pipeline scoreboard --json` that calls the shared classifier, and verify two physical runs of one completed logical operation produce denominator 1 for unique-operation success
- [ ] 5.2 Keep existing attempt/run/PR metrics labeled as attempt metrics, and verify they are not used as the unique-operation success-rate denominator
- [ ] 5.3 Diagnose historical runs without `logical_operation_id` as missing correlation without inventing an id, and verify the scoreboard still emits a valid JSON object
- [ ] 5.4 Attribute production outcomes to `logical_operation_id` when the run stores it, and verify a label-only ready-to-deploy fixture is not counted as unique-operation verified success

## 6. Regression tests that must fail without the fix

- [ ] 6.1 Prove a retry or fresh-process resume does not double-count a logical operation, and verify the test fails if the aggregator keys by `run_id`
- [ ] 6.2 Prove a reconciled completed side effect contributes one completion to the original logical operation and does not replay the side effect, and verify the test fails if a second mutation is attempted
- [ ] 6.3 Prove #1333 mechanical-fault fixtures, once present, yield zero false-human projections and zero ownerless terminals for a passing gate, and verify a false-human fixture refuses release-eligible pass
- [ ] 6.4 Prove applicable exact-candidate recovery and independent-sibling continuation fixtures pass at 100% when required, and verify a sibling halt on a contained peer failure refuses the independent-sibling rate
- [ ] 6.5 Run unit tests through injected seams with no real network, git, or subprocess, and verify `cd core && npm test` covers the new files

## 7. Docs, packaging, and CI

- [ ] 7.1 Document unique-operation SLOs, the `operation_reliability` evidence section, and fail-closed missing-correlation rules in `docs/factory-reliability-gate-runbook.md`, and verify the runbook names numerators, denominators, exclusions, and integrity counts
- [ ] 7.2 Keep `CONTEXT.md` and ADR 0004 terms aligned with the living specs (Logical operation, Execution attempt, Verified completion, Manual reinvocation, False-human projection, Ownerless terminal), and verify the glossary still forbids using run id or issue closure as the reliability denominator
- [ ] 7.3 After any `core/` edit run `node scripts/build.mjs` and refresh generated docs if the generator is present, and verify `node scripts/build.mjs --check` and `npm run ci` pass
- [ ] 7.4 Run `openspec validate unique-operation-reliability-gate` and `openspec validate --all`, and verify both exit 0
