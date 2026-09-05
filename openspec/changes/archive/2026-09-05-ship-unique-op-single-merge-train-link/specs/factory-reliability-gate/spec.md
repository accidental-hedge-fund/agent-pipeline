## MODIFIED Requirements

### Requirement: In-flight ship unique-operation scoring SHALL observe single, merge, and merge-queue from control-host artifacts

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL observe required public entrypoints `single`, `merge`, and `merge-queue` from control-host run artifacts in the dual-root pair unique-operation collection scores. Those artifacts SHALL carry a recognized `run.json.kind`, `run_start.entrypoint`, command identity, or documented run-id prefix. Scoring SHALL NOT invent those entrypoints from numeric drive ids, `kind: "advance"`, nested `train_merge_*` events, pack-issue labels, comment prose, or a persist that landed only under a candidate-worktree run store that is not an approved collection root. Absence of those artifacts from the approved roots SHALL increment missing required coverage. This requirement SHALL NOT drop `ship` from the required public entrypoint inventory.

#### Scenario: Recognized single merge and merge-queue artifacts are observed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host generic run store or loop state-home contains recognizable `single`, `merge`, and `merge-queue` artifacts
- **THEN** `entrypoint_coverage.observed` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL NOT increase for those three entrypoints

#### Scenario: Candidate-worktree-only persist does not satisfy in-flight ship coverage

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** recognizable `single`, `merge`, and `merge-queue` artifacts exist only under a candidate-worktree run store that is not an approved collection root
- **AND** the approved dual-root pair does not contain those artifacts
- **THEN** `entrypoint_coverage.missing` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL increase
- **AND** release-eligible pass SHALL be refused

#### Scenario: Missing single merge and merge-queue stay fail-closed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host stores have `train-*` and numeric-drive artifacts only
- **THEN** `entrypoint_coverage.missing` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL increase
- **AND** release-eligible pass SHALL be refused

### Requirement: In-flight ship FRG scoring SHALL count followable control-host train_loop_linked as #1301 live train-link

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, #1301 live train-link SHALL be present when the control-host train stream contains a followable `train_loop_linked` event (nonempty child loop run id, absolute events path that loads the linked child inside the approved control-host roots, and a child logical id inherited from the parent train operation). The scored train operation SHALL carry that followable child logical id. The join SHALL resolve that child by the event's validated absolute events path. First-occurrence run-id deduplication across approved roots SHALL NOT choose the child used for train-link validation. The factory-gate pack loop store SHALL NOT be the only allowed source. A `train` entrypoint without that followable child SHALL NOT satisfy #1301. Observing entrypoint `train` alone SHALL NOT satisfy #1301. This requirement SHALL NOT invent `train_loop_linked`.

#### Scenario: Followable control-host train_loop_linked satisfies #1301 on in-flight ship

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** a control-host train stream contains a followable `train_loop_linked` event
- **AND** the factory-gate pack loop store has no train events
- **THEN** the scored train operation SHALL carry a followable child logical id inherited from the parent
- **AND** #1301 live train-link SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase for that live train-link cell

#### Scenario: Parent-inherited child logical id satisfies #1301 when event and child omit a minted id

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** a control-host train stream contains a followable `train_loop_linked` event
- **AND** the event has no `logical_operation_id`
- **AND** the loaded child has no minted logical id
- **AND** the parent train has logical identity `T`
- **THEN** the scored train operation SHALL carry child logical id `T`
- **AND** #1301 live train-link SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase for that live train-link cell

#### Scenario: Train without followable child fails #1301

- **WHEN** in-flight ship FRG scoring observes entrypoint `train`
- **AND** no followable `train_loop_linked` event exists on the control-host train stream
- **THEN** missing required coverage SHALL increase for #1301 live train-link
- **AND** release-eligible pass SHALL be refused

#### Scenario: Train entrypoint without inherited child logical id fails #1301

- **WHEN** in-flight ship FRG scoring observes entrypoint `train`
- **AND** a `train_loop_linked` event exists on the control-host train stream
- **AND** the scored train operation does not carry a followable child logical id inherited from the parent
- **THEN** missing required coverage SHALL increase for #1301 live train-link
- **AND** release-eligible pass SHALL be refused

#### Scenario: Duplicate run id in an earlier approved root does not drop a followable control-host train link

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** a control-host train stream contains a followable `train_loop_linked` event
- **AND** an earlier approved root contains a different artifact with the same child run id
- **AND** that event's absolute events path loads the linked child inside a later approved root
- **THEN** #1301 live train-link SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase for that live train-link cell
