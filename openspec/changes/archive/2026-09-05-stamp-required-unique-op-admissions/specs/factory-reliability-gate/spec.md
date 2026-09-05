## MODIFIED Requirements

### Requirement: Unmet unique-operation SLOs SHALL fail FRG promotion and release preparation

The FRG driver and shared release-eligibility validator SHALL refuse `pass: true` and SHALL stop release preparation when any of the following hold: required clean operations did not reach verified completion without Manual reinvocation; false-human projection count is not zero; ownerless terminal count is not zero; an applicable exact-candidate recovery fixture failed; an applicable independent-sibling continuation fixture failed; correlation is missing or contradictory; required public entry-point coverage is missing. Those gaps SHALL be integrity or SLO failures. They SHALL NOT be recorded as stable exclusions. `uniqueOperationSloFailure` SHALL remain a prepare hard-gate failure and SHALL NOT be demoted to advisory status or replaced by synthesized coverage or human attestation.

#### Scenario: Missing correlation fails release-eligible pass

- **WHEN** a required FRG entry point ran without a `logical_operation_id` or with contradictory parent/child identities
- **THEN** overall FRG `pass` SHALL be false
- **AND** release preparation SHALL stop
- **AND** the evidence SHALL expose a missing-correlation or contradictory-correlation integrity count

#### Scenario: False-human projection fails the gate

- **WHEN** the #1333 mechanical fault matrix, once integrated, records a mechanical fault projected as human ownership
- **THEN** `operation_reliability` false-human count SHALL be greater than zero
- **AND** release-eligible `pass: true` SHALL be refused

#### Scenario: Ownerless terminal fails the gate

- **WHEN** an admitted FRG operation ends with neither verified success, durable cooling or recovery, external-condition wait, typed request, nor explicit cancellation
- **THEN** ownerless-terminal count SHALL be greater than zero
- **AND** release-eligible `pass: true` SHALL be refused

#### Scenario: Clean completion requires no Manual reinvocation

- **WHEN** a required clean FRG operation reaches verified completion only after an operator or supervisor reinvokes the public command without a valid resume binding
- **THEN** clean-completion without Manual reinvocation SHALL fail
- **AND** release-eligible `pass: true` SHALL be refused

#### Scenario: Missing stamped entrypoint coverage remains a prepare hard failure

- **WHEN** required `single`, `merge`, or `merge-queue` coverage is absent from qualifying durable control-host artifacts
- **THEN** `uniqueOperationSloFailure` SHALL return a missing-required-coverage failure
- **AND** release preparation SHALL stop
- **AND** the gap SHALL NOT become advisory, synthesized coverage, or a human-attestation request

### Requirement: In-flight ship unique-operation scoring SHALL observe single, merge, and merge-queue from control-host artifacts

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL observe required public entrypoints `single`, `merge`, and `merge-queue` only from qualifying control-host run artifacts in the approved roots. A qualifying artifact SHALL carry the matching durable run kind or start-event entrypoint and a non-empty aggregation identity. A train-nested merge artifact that is durably recorded as `merge` and retains the train root `logical_operation_id` SHALL observe `merge` while remaining part of the same Logical Operation as the outer `train` record. The admission stamp SHALL establish entrypoint presence only; it SHALL NOT establish verified completion or success. Scoring SHALL NOT invent those entrypoints from numeric drive ids, `kind: "advance"`, raw `train_merge_*` events, pack-issue labels, comment prose, or an artifact outside the approved roots. Absence of qualifying artifacts SHALL increment missing required coverage. This requirement SHALL NOT remove `single`, `merge`, or `merge-queue` from the required public entrypoint inventory.

#### Scenario: Recognized single merge and merge-queue artifacts are observed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the approved control-host roots contain qualifying direct `single`, `merge`, and `merge-queue` admission artifacts
- **THEN** `entrypoint_coverage.observed` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL NOT increase for those three entrypoints

#### Scenario: Nested train merge artifact observes merge under the train root identity

- **WHEN** in-flight ship FRG scoring collects an outer `train` artifact with logical identity `T`
- **AND** it collects a distinct qualifying train-nested artifact with entrypoint `merge` and logical identity `T`
- **THEN** `entrypoint_coverage.observed` SHALL include both `train` and `merge`
- **AND** aggregation SHALL retain one root Logical Operation identity `T`
- **AND** the nested admission stamp alone SHALL NOT count `T` as verified completion

#### Scenario: Raw train merge event is not qualifying merge coverage

- **WHEN** a train artifact contains `train_merge_attempted` or `train_merge_proven`
- **AND** no qualifying nested `merge` admission artifact exists in the approved roots
- **THEN** `entrypoint_coverage.observed` SHALL NOT include `merge` from that event alone

#### Scenario: Candidate-worktree-only persist does not satisfy in-flight ship coverage

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** recognizable `single`, `merge`, and `merge-queue` artifacts exist only outside the approved control-host roots
- **AND** the approved roots do not contain those artifacts
- **THEN** `entrypoint_coverage.missing` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL increase
- **AND** release-eligible pass SHALL be refused

#### Scenario: Missing single merge and merge-queue stay fail-closed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the approved control-host roots contain only `drive`, `loop`, and `train` artifacts
- **THEN** `entrypoint_coverage.missing` SHALL include `single`, `merge`, and `merge-queue`
- **AND** numeric drive SHALL NOT satisfy `single`
- **AND** release-eligible pass SHALL be refused
