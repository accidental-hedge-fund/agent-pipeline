## ADDED Requirements

### Requirement: Ship FRG unique-operation scoring SHALL use control-host durable evidence bound to the scored candidate

Ship FRG unique-operation scoring SHALL collect unique-operation attempts and #1301 live train-loop linkage from the control-host durable run, event, loop-store, and handoff store bound to the scored candidate. It SHALL NOT treat an empty candidate-worktree `.agent-pipeline/runs` directory as proof that train, loop, merge, or merge-queue never ran. It SHALL pass candidate-bound #1333 executed matrix rows through the existing unique-operation coverage seam from that same control-host or engine evidence. GitHub pack-issue labels, comment prose, and factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) SHALL NOT substitute for unique-operation coverage. When the control-host store bound to the scored candidate is empty of train, loop, and merge evidence, unique-operation coverage SHALL fail closed as missing required coverage. This capability SHALL NOT add a second unique-operation aggregator, Factory Reliability Gate runner, or scheduler.

#### Scenario: Empty candidate-worktree run-store does not fail a host-proven ship

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host durable store has train, loop, and merge unique-operation evidence bound to `C`
- **AND** hybrid v2 pack proofs pass
- **THEN** FRG structural eligibility SHALL NOT fail solely because the candidate worktree run-store is empty
- **AND** `isReleaseEligibleFrgPass` with attestation optional SHALL be true when remaining unique-operation SLOs and bindings hold

#### Scenario: Empty control-host store remains fail-closed

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host durable store bound to `C` has no train, loop, or merge unique-operation evidence
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused
- **AND** pack-issue `pipeline:ready-to-deploy` labels SHALL NOT satisfy that coverage

#### Scenario: Empty control-host store remains fail-closed when candidate-worktree artifacts match

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host durable store bound to `C` has no train, loop, or merge unique-operation evidence
- **AND** the candidate worktree `.agent-pipeline/runs` has matching unique-operation attempts and executed-matrix rows bound to `C`
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused

#### Scenario: Pack proofs are not unique-operation substitutes

- **WHEN** factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) pass
- **AND** durable unique-operation evidence bound to the scored candidate is absent
- **THEN** release-eligible pass SHALL be refused
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: #1333 rows come from control-host or engine evidence for the candidate

- **WHEN** ship FRG unique-operation scoring runs for candidate SHA `C`
- **AND** executed matrix rows bound to `C` exist in control-host or engine evidence
- **THEN** those rows SHALL feed #1333 `covered_lifecycle_classes` through the existing binder
- **AND** helper stamps and pack labels SHALL NOT populate that coverage
- **AND** absence of bound executed rows SHALL fail as missing required coverage

---

### Requirement: In-flight ship SHALL NOT count as missing unique-operation coverage for that ship's FRG pack

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, required public entrypoint `ship` SHALL NOT increment missing required coverage for lack of a completed unique-operation of that same ship. A completed prior `ship` unique-operation bound to the scored candidate SHALL remain valid coverage. Other required public entrypoints (`drive`, `single`, `loop`, `train`, `merge`, `merge-queue`) SHALL keep fail-closed missing-coverage rules. This requirement SHALL NOT drop `ship` from the required public entrypoint inventory and SHALL NOT treat an in-flight ship as verified unique-operation success.

#### Scenario: In-flight ship is not a missing-coverage fail

- **WHEN** `pipeline ship` is in flight and its FRG pack is scored
- **AND** no completed unique-operation exists for that same ship admission
- **AND** other required entrypoints have bound durable coverage
- **THEN** missing required coverage SHALL NOT increase for entrypoint `ship`
- **AND** release-eligible unique-operation validation SHALL NOT fail solely for that in-flight `ship` gap

#### Scenario: Completed prior ship remains valid coverage

- **WHEN** a completed prior `ship` unique-operation is bound to the scored candidate
- **THEN** entrypoint `ship` SHALL count as observed coverage
- **AND** that prior operation SHALL NOT be treated as the in-flight ship's verified success

#### Scenario: Other missing entrypoints still fail

- **WHEN** ship FRG unique-operation scoring runs as a phase of an in-flight ship
- **AND** durable evidence for required entrypoint `train` is absent from the control-host store bound to the scored candidate
- **THEN** missing required coverage SHALL increase for `train`
- **AND** release-eligible pass SHALL be refused

---

### Requirement: Factory-release structural eligibility failure SHALL name unique-operation SLO or binding failure

When `factory-release prepare` refuses structural eligibility because unique-operation SLOs or unique-operation release bindings fail, the hard-gate message SHALL include the unique-operation SLO failure string or the unique-operation release-binding failure string. A generic structural-eligibility sentence without that string SHALL NOT be the only diagnostic when unique-operation validation is the defect. HMAC attestation on the tag and promote path SHALL remain required.

#### Scenario: Unique-operation SLO failure is named on the hard gate

- **WHEN** hybrid v2 pack proofs pass
- **AND** unique-operation SLO validation returns a failure string
- **AND** `factory-release prepare` scores that pack as not structurally eligible
- **THEN** the hard-gate message SHALL include that unique-operation SLO failure string
- **AND** the command SHALL NOT return `status: "complete"`

#### Scenario: Unique-operation binding failure is named on the hard gate

- **WHEN** unique-operation release-binding validation returns a failure string
- **AND** `factory-release prepare` scores that pack as not structurally eligible
- **THEN** the hard-gate message SHALL include that binding failure string

## MODIFIED Requirements

### Requirement: FRG unique-operation scoring SHALL require integrated #1301 and #1333 proofs

Release-eligible FRG pass SHALL require the #1301 live train-loop linkage, collision-safe train run identity, and merge-proof events, and SHALL require the #1333 mechanical fault matrix to cover every required lifecycle class for the scored candidate. Absence of those proofs SHALL fail FRG promotion. Helper fixtures that stamp required lifecycle classes without executed matrix rows SHALL NOT satisfy the #1333 proof. #1301 live `train_loop_linked` for a ship FRG pack SHALL be scored from the control-host train stream bound to the scored candidate when that stream exists. It SHALL NOT be scored from the factory-gate pack loop alone. This capability SHALL NOT create a second scheduler, recovery owner, or fault-matrix runner.

#### Scenario: Missing #1333 coverage fails promotion

- **WHEN** a required lifecycle class in the #1333 matrix is uncovered for the candidate
- **THEN** FRG promotion SHALL fail
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: Stamped coverage without matrix rows fails promotion

- **WHEN** unique-operation evidence lists required lifecycle classes as covered
- **AND** the universal-fault-recovery-matrix inventory has no executed covering row for a required class
- **THEN** FRG promotion SHALL fail
- **AND** the gap SHALL NOT be recorded as a stable exclusion

#### Scenario: Missing #1301 live linkage fails promotion

- **WHEN** a train-driven nested loop has no followable `train_loop_linked` identity from the child `onRunReady` handoff
- **THEN** FRG promotion SHALL fail as missing correlation or missing required coverage
- **AND** the driver SHALL NOT guess the child run by latest-run lookup
- **AND** a `train_loop_linked` event that carries only the parent logical id SHALL NOT count as followable child linkage

#### Scenario: #1301 live linkage is scored from the control-host train stream

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host train stream bound to `C` contains a followable `train_loop_linked` identity from the child `onRunReady` handoff
- **AND** the factory-gate pack loop store has no train events
- **THEN** #1301 live train-loop linkage SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase solely because the pack loop lacks `train_loop_linked`
