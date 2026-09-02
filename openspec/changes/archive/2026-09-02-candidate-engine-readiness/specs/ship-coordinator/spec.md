## MODIFIED Requirements

### Requirement: Ship coordinator post-train phases SHALL execute the candidate engine

After `train --merge` is complete or resumed complete, in-engine `pipeline ship` SHALL run Factory Reliability Gate (FRG) pack (`factory-release prepare` and `factory-gate`), `pipeline release`, `release finish`, and any coordinator-invoked tag on the candidate engine bound to the SHA being released. The candidate engine SHALL be the control checkout at that SHA, or an explicit candidate install of that SHA. The coordinator SHALL obtain that root from the shared asynchronous resolve-and-prepare seam. Identity-only resolution SHALL NOT authorize leaf spawn.

When the operator started `pipeline ship` from the previous production-pin CLI, the coordinator SHALL keep that pin process as the durable coordinator and SHALL spawn the candidate engine for leaf post-train verbs (`factory-release prepare`, `factory-gate`, `release`, `release finish`, and `release ensure-tag`). After a successful candidate `factory-gate`, the coordinator SHALL re-invoke the same candidate `factory-release prepare --request <absolute-request.json> --json` once. When that prepare returns `status: "complete"`, the FRG pack phase SHALL return. When that prepare still returns `status: "awaiting_frg_attestation"` because observation is absent or rejected, the FRG pack phase SHALL fail closed and SHALL name unsigned `frg_run_id` `A`, observed `latest.json` `run_id` `B` when present, and the observe miss reason. It SHALL NOT spawn factory-gate again for that unchanged checkpoint. It SHALL NOT return from the FRG pack phase at the first attestation checkpoint. It SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint. `release ensure-tag` SHALL run the candidate's `ensureAnnotatedReleaseTag`; it SHALL NOT import that helper from the production-pin process. It SHALL NOT re-exec `pipeline ship`. It SHALL NOT rerun train. It SHALL NOT keep executing those leaf verbs inside the production-pin process when that process source SHA differs from the candidate. Train and `engine-promote` SHALL remain on the production pin.

The coordinator SHALL fail closed before those ship-end verbs if it cannot resolve-and-prepare a matching runnable candidate engine. A failed resolution or failed candidate readiness SHALL persist the train checkpoint and SHALL NOT start FRG pack or release mutation. Setup failure, abandoned ownership, and lock uncertainty SHALL remain supervised lifecycle states (bounded treatment, Cooling, or External-condition wait) and SHALL NOT become generic blocked, needs-human, or terminal mechanical failure. They SHALL NOT create a DecisionRequest or AuthorityRequest. This requirement does not authorize `--skip-frg` as the default. It does not authorize promote before GitHub Release publication. It does not add a new recover recipe, `auto_merge`, a merge stage, or a special ship of the readiness gate.

#### Scenario: Production-pin ship switches to candidate after train

- **WHEN** an operator runs production-pin `pipeline ship --milestone v1.39.5`
- **AND** train completes with FRG-bound candidate SHA `C` whose version is `1.39.5`
- **THEN** the coordinator SHALL spawn `factory-release prepare` and `pipeline release` on the candidate engine at `C`
- **AND** it SHALL NOT open the release PR using the `1.39.4` production-pin `release.ts`

#### Scenario: Unresolvable candidate stops ship before release

- **WHEN** train is complete
- **AND** the coordinator cannot resolve a candidate engine matching the FRG-bound SHA
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** status SHALL name the candidate-engine identity defect
- **AND** persisted train evidence SHALL remain so a retry does not retrain

#### Scenario: Handoff does not re-enter ship or train

- **WHEN** the pin coordinator spawns the candidate for a post-train verb
- **THEN** the spawned argv SHALL be a leaf CLI verb
- **AND** it SHALL NOT be `pipeline ship --milestone`
- **AND** it SHALL NOT be `pipeline train`

#### Scenario: Candidate FRG pack converges prepare after attestation

- **WHEN** candidate `factory-release prepare --request <absolute-request.json> --json` returns `status: "awaiting_frg_attestation"`
- **AND** candidate `factory-gate --for <X.Y.Z> --from-run <loop_run_id>` succeeds
- **THEN** the coordinator SHALL re-invoke the same candidate `factory-release prepare` with that unchanged request once
- **AND** when that prepare returns `status: "complete"`, the FRG pack phase SHALL return
- **AND** when that prepare still returns `status: "awaiting_frg_attestation"`, the FRG pack phase SHALL fail closed
- **AND** it SHALL NOT spawn factory-gate again for that unchanged checkpoint
- **AND** it SHALL NOT treat the later standalone `pipeline release` leaf as a substitute for that complete checkpoint

#### Scenario: Coordinator-invoked tag runs candidate ensure-tag

- **WHEN** the pin coordinator waits for publication after a merged release
- **AND** the pin process SHA differs from the FRG-bound candidate SHA
- **THEN** the coordinator SHALL spawn `release ensure-tag <X.Y.Z> <merge-commit-oid>` on the candidate launcher
- **AND** it SHALL NOT call the production-pin process's imported `ensureAnnotatedReleaseTag`

#### Scenario: Unready candidate stops ship before leaf spawn

- **WHEN** train is complete
- **AND** a candidate-engine root matches the FRG-bound SHA
- **AND** resolve-and-prepare fails to prove candidate readiness
- **THEN** ship SHALL stop before `pipeline factory-release prepare` and before `pipeline release`
- **AND** persisted train evidence SHALL remain so a retry does not retrain
- **AND** no candidate leaf command SHALL have spawned

#### Scenario: Setup failure is not needs-human

- **WHEN** in-engine `pipeline ship` fails closed on candidate setup or abandoned ownership
- **THEN** the outcome SHALL be a supervised lifecycle state (bounded treatment, Cooling, or External-condition wait)
- **AND** it SHALL NOT be generic blocked, needs-human, or terminal mechanical failure
- **AND** it SHALL NOT create a DecisionRequest or AuthorityRequest solely for that failure
