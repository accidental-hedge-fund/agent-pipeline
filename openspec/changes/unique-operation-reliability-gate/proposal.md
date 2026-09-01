## Why

Current scoreboards and Factory Reliability Gate (FRG) reports count run attempts, stage outcomes, blocker classes, and closed incidents. They do not answer whether one admitted logical operation reached verified completion without manual reinvocation. Retries inflate denominators, issue closure hides repeated nonterminal exits, and a green FRG can coexist with a false-human projection or an ownerless terminal. Releases can then optimize incident closure while public `single`, `train`, and `ship` workflows stay operationally unreliable.

## What Changes

- Mint one opaque immutable `logical_operation_id` at public-command admission and retain it across retry, restart, reattachment, nested child work, train waves, ship phases, and attestation ticks. Keep `run_id` as the physical execution identity.
- Correlate numeric drive, `single`, `loop`, `train`, `merge`, merge queue, `ship`, and their nested child runs to that identity. A new external admission receives a new identity unless it presents a valid resume binding.
- Produce a versioned `operation_reliability` evidence section on existing FRG evidence. Deduplicate every reliability denominator by `logical_operation_id`. Do not substitute attempt counts, raw run counts, or closed-issue counts.
- Gate FRG promotion and release preparation on unique-operation SLOs: 100% clean completion without manual reinvocation for required clean operations; zero false-human projections; zero ownerless terminals; 100% applicable exact-candidate recovery; 100% applicable independent-sibling continuation. Missing correlation or missing required entry-point coverage is an integrity failure, never an exclusion.
- Require every admitted supervised operation to end as verified success, durable cooling/recovery, external-condition wait, typed decision/capability/authority request, or explicit operator cancellation.
- Make existing scoreboard and outcome surfaces consume the shared correlated facts. Do not reclassify prose or labels independently.
- Treat #1301 live train linkage / collision-safe run identity and the #1333 mechanical fault matrix as required proofs for this gate. A reconciled completed side effect contributes one completion to its original logical operation.

## Capabilities

### New Capabilities

- `operation-reliability`: logical-operation identity, resume binding, verified-completion proof, closed terminal-outcome set, unique-operation SLO report, and integrity failure for missing correlation or missing required coverage.

### Modified Capabilities

- `factory-reliability-gate`: require a versioned `operation_reliability` section on release-eligible FRG evidence; fail promotion and release preparation when unique-operation SLOs or integrity counts are unmet; consume #1301 and #1333 proofs rather than inventing a second pack or scheduler.
- `factory-scoreboard`: report unique-operation numerators, denominators, stable exclusions, and missing-correlation counts from shared correlated facts; do not use attempt, run, or closed-issue counts as the success-rate denominator.
- `events-jsonl-streaming`: stamp `logical_operation_id` on admission and nested-child events as an additive field; retries and fresh-process resumes MUST NOT mint a second identity for the same logical operation.
- `evidence-bundle`: persist `logical_operation_id` on `run.json` and finalized `summary.json` as written-once identity next to `run_id`.
- `durable-loop-store`: retain the parent `logical_operation_id` on nested loop runs so child work stays correlated without a second store.
- `train-event-stream`: propagate the train admission identity to linked child loop runs through existing `train_loop_linked` / `onRunReady` handoff, once #1301 live linkage is present.
- `production-outcome-records`: attribute outcomes to `logical_operation_id` when present; do not independently reclassify labels or prose as reliability success.

## Impact

- **Reuse first:** extend `initRunDir` / `run.json`, existing FRG `FrgEvidence` + `validateReleaseEligibleFrgEvidence`, existing scoreboard aggregation, existing loop store, and existing train event handoff. Do not add a scheduler, recovery owner, scoreboard verb, or evidence store.
- **CLI:** no new public verb. `pipeline factory-gate`, `pipeline scoreboard --json`, and release-prepare validation expose the shared section.
- **Tests:** hermetic injected I/O proving retries and fresh-process resumes do not double-count or replay a completed side effect; missing correlation fails FRG/release; #1333 mechanical fixtures produce zero false-human and zero ownerless terminals once that matrix is integrated.
- **Docs:** FRG runbook, generated CLI/scoreboard docs, and `CONTEXT.md` terms stay aligned. `node scripts/build.mjs` after `core/` edits. `npm run ci` must pass.
- **Sequencing:** this gate cannot pass until #1301 and #1333 are integrated. Missing those proofs is an integrity failure, not an exclusion.

## Acceptance Criteria

- [ ] Every admitted numeric drive, `single`, `loop`, `train`, `merge`, merge-queue, and `ship` operation, plus nested child runs, carries one stable `logical_operation_id` from admission through verified completion or a closed terminal outcome.
- [ ] A retry, restart, reattachment, train wave, ship phase, or attestation tick for the same logical operation does not mint a second identity and does not count as a second successful operation.
- [ ] A new external admission without a valid resume binding receives a new `logical_operation_id`.
- [ ] Verified completion is proven by exact-candidate postcondition evidence. Process exit, `run_complete`, and issue closure alone are not success.
- [ ] Every admitted supervised operation ends as verified success, durable cooling/recovery, external-condition wait, typed decision/capability/authority request, or explicit operator cancellation.
- [ ] Required clean FRG operations reach verified completion without manual reinvocation (100%).
- [ ] The #1333 mechanical fault matrix produces zero false-human projections and zero ownerless terminals.
- [ ] Applicable exact-candidate recovery and independent-sibling continuation fixtures pass at 100%.
- [ ] FRG `operation_reliability` reports expose numerators, denominators, stable exclusions, integrity counts, and per-operation evidence references. Attempt counts are not substituted for unique operations.
- [ ] Missing correlation, missing required entry-point coverage, or an unmet SLO fails FRG promotion and release preparation. Those gaps are never treated as exclusions.
- [ ] Legitimate typed requests, external waits, and cancellations are excluded from clean completion only when the versioned pack manifest declares that expected outcome. They remain separately counted and contract-validated.
- [ ] Scoreboard and outcome surfaces consume the shared correlated facts. They do not reclassify prose or labels independently.
- [ ] Tests prove retries and fresh-process resumes do not double-count an operation or replay a completed side effect.
- [ ] Living specs, generated docs, FRG runbook, and `npm run ci` agree.
- [ ] No new scheduler or recovery owner is introduced.
