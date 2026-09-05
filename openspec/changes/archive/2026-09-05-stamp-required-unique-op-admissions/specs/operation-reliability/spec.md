## MODIFIED Requirements

### Requirement: Nested child runs SHALL inherit the parent logical_operation_id

Nested child work spawned by an admitted parent (train → loop, train merge mode → merge, ship → pack loop, parent-spawned `single`) SHALL copy the parent's `logical_operation_id` through the existing parent handoff. Nested child runs SHALL NOT mint a second logical identity. A nested merge admission SHALL use a distinct physical run record whose public entrypoint, `run.json.kind`, and `run_start.entrypoint` are `merge` while retaining the parent train Logical Operation identity. Retraining waves, ship phases, and attestation ticks for that parent SHALL keep the same identity.

#### Scenario: Train child loop inherits the train identity

- **WHEN** an admitted `pipeline train` starts a nested loop run
- **THEN** the child loop run SHALL carry the train's `logical_operation_id`
- **AND** SHALL NOT mint a distinct logical identity

#### Scenario: Train nested merge inherits the train identity without losing merge identity

- **WHEN** an admitted `pipeline train --merge` is about to perform a nested merge
- **THEN** the nested merge record SHALL carry the train's `logical_operation_id`
- **AND** its physical run record SHALL identify public entrypoint and run kind `merge`
- **AND** the distinct outer train record SHALL remain identified as `train`

#### Scenario: Attestation tick is not a new operation

- **WHEN** a ship or FRG attestation tick records evidence for an already admitted operation
- **THEN** that tick SHALL keep the original `logical_operation_id`
- **AND** SHALL NOT increment unique-operation success counts by itself

### Requirement: Public single, merge, and merge-queue admissions SHALL persist recognizable control-host run artifacts

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue`, plus each merge admitted inside `pipeline train --merge`, SHALL use one shared unique-operation admission contract. Before the admitted operation crosses its protected execution or side-effect boundary, that contract SHALL durably persist and read-back verify a qualifying artifact in the control-host generic run store. The artifact SHALL carry the exact public entrypoint, matching `run.json.kind` and `run_start.entrypoint`, a non-empty `logical_operation_id`, and the existing non-secret run metadata. Direct admissions SHALL use their admitted root Logical Operation identity. A train-nested merge SHALL retain the train root `logical_operation_id` in a distinct `merge` physical record.

A persistence or verification failure SHALL refuse the protected boundary and SHALL be reported as mechanical lifecycle evidence under the existing recovery policy. It SHALL NOT claim entrypoint coverage, success, completion, or human authority. A persisted admission stamp SHALL prove only that an attempt was admitted. It SHALL NOT by itself prove verified completion, a completed side effect, merge authority, release authority, or success. Nested child loop work SHALL remain a distinct mapped `loop` entrypoint. Numeric drive (`<issue>-<timestamp>`) SHALL remain `drive`. Unrecognized `kind` values such as `advance` SHALL NOT become `single`. A raw `train_merge_*` event without a qualifying nested merge admission artifact SHALL NOT count as `merge`. Collection SHALL NOT invent a present or successful entrypoint when its qualifying artifact is absent from the approved roots.

#### Scenario: Single admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline single 42`
- **THEN** the control-host generic run store SHALL contain a read-back-verified artifact whose public entrypoint, `run.json.kind`, and `run_start.entrypoint` are `single`
- **AND** the artifact SHALL contain the admission's non-empty `logical_operation_id`
- **AND** the supervised drive SHALL NOT start before that persistence succeeds

#### Scenario: Merge admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **THEN** the control-host generic run store SHALL contain a read-back-verified artifact whose public entrypoint, `run.json.kind`, and `run_start.entrypoint` are `merge`
- **AND** the merge side effect SHALL NOT be submitted before that persistence succeeds

#### Scenario: Merge-queue admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge-queue --apply`
- **THEN** the control-host generic run store SHALL contain a read-back-verified artifact whose public entrypoint, `run.json.kind`, and `run_start.entrypoint` are `merge-queue`
- **AND** no merge, repair, or other protected apply side effect SHALL start before that persistence succeeds

#### Scenario: Nested train merge is not a public merge admission

- **WHEN** an admitted `pipeline train --merge` reaches a merge submission for PR `P`
- **THEN** the control-host generic run store SHALL contain a distinct nested artifact whose public entrypoint, `run.json.kind`, and `run_start.entrypoint` are `merge`
- **AND** that artifact SHALL carry the outer train's `logical_operation_id`
- **AND** that nested artifact SHALL remain distinguishable from a direct public `pipeline merge` admission
- **AND** the merge side effect for `P` SHALL NOT be submitted before that nested artifact is durably verified

#### Scenario: Admission persistence failure is mechanically owned

- **WHEN** the shared admission contract cannot persist or read-back verify its qualifying artifact
- **THEN** the protected operation boundary SHALL be refused
- **AND** the failure SHALL be reported as mechanical lifecycle evidence under the existing recovery policy
- **AND** it SHALL NOT be projected as human authority unless independent evidence establishes a genuine typed request

#### Scenario: Admission stamp is not completion or authority

- **WHEN** a qualifying `merge` or `merge-queue` admission artifact exists
- **AND** no authoritative postcondition proof exists for its protected side effect
- **THEN** collection MAY observe the recorded public entrypoint
- **AND** the Logical Operation SHALL NOT count as verified completion or success from that stamp alone
- **AND** the stamp SHALL NOT grant merge or release authority

#### Scenario: Numeric drive remains distinct from single

- **WHEN** an issue is admitted through numeric `pipeline 42`
- **THEN** its public entrypoint SHALL remain `drive`
- **AND** its artifact SHALL NOT satisfy required `single` coverage

#### Scenario: Raw train merge events do not replace a nested admission artifact

- **WHEN** a train stream contains `train_merge_attempted` or `train_merge_proven`
- **AND** no qualifying nested `merge` admission artifact exists in the approved control-host roots
- **THEN** entrypoint coverage SHALL NOT observe `merge` from those events

#### Scenario: Absent artifacts stay fail-closed

- **WHEN** unique-operation scoring collects attempts from the control-host stores
- **AND** no qualifying `single`, `merge`, or `merge-queue` admission artifact exists
- **THEN** missing required coverage SHALL increase for each absent entrypoint
- **AND** scoring SHALL NOT mint a synthetic presence or success for those entrypoints

## ADDED Requirements

### Requirement: Required public entrypoints SHALL have a machine-checked shared admission inventory

The pipeline SHALL maintain one machine-checked inventory that identifies the canonical durable admission site for every member of `REQUIRED_PUBLIC_ENTRYPOINTS`. `single`, `merge`, and `merge-queue` SHALL remain required members, and the inventory SHALL include direct admission sites for all three plus the train merge-mode nested `merge` site. CI SHALL compare the required-entrypoint set with the shared admission inventory and SHALL fail when a required member has no declared shared admission site. Inventory presence alone SHALL NOT substitute for behavioral tests that exercise each declared site through the shared contract.

#### Scenario: New required entrypoint without an admission site fails CI

- **WHEN** an entrypoint is added to `REQUIRED_PUBLIC_ENTRYPOINTS`
- **AND** no canonical durable admission site is added to the shared inventory
- **THEN** the machine-checked inventory gate SHALL fail

#### Scenario: Required merge surfaces are represented by the shared contract

- **WHEN** the shared admission inventory is validated
- **THEN** `single`, `merge`, and `merge-queue` SHALL be present as required public entrypoints
- **AND** direct single, direct merge, direct merge-queue, and train-nested merge SHALL be represented as shared-contract admission sites

#### Scenario: Declarative inventory without exercised admission is insufficient

- **WHEN** an inventory entry names a required public entrypoint
- **AND** the corresponding network-free admission test does not produce a qualifying artifact through the shared contract
- **THEN** CI SHALL fail
