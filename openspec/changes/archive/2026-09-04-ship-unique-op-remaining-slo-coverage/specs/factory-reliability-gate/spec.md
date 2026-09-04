## ADDED Requirements

### Requirement: In-flight ship unique-operation scoring SHALL observe single, merge, and merge-queue from control-host artifacts

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL observe required public entrypoints `single`, `merge`, and `merge-queue` from control-host run artifacts that carry a recognized `run.json.kind`, `run_start.entrypoint`, or documented run-id prefix. Scoring SHALL NOT invent those entrypoints from numeric drive ids, `kind: "advance"`, nested `train_merge_*` events, pack-issue labels, or comment prose. Absence of those artifacts SHALL increment missing required coverage. This requirement SHALL NOT drop `ship` from the required public entrypoint inventory.

#### Scenario: Recognized single merge and merge-queue artifacts are observed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host generic run store or loop state-home contains recognizable `single`, `merge`, and `merge-queue` artifacts
- **THEN** `entrypoint_coverage.observed` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL NOT increase for those three entrypoints

#### Scenario: Missing single merge and merge-queue stay fail-closed

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host stores have `train-*` and numeric-drive artifacts only
- **THEN** `entrypoint_coverage.missing` SHALL include `single`, `merge`, and `merge-queue`
- **AND** missing required coverage SHALL increase
- **AND** release-eligible pass SHALL be refused

---

### Requirement: In-flight ship FRG scoring SHALL count followable control-host train_loop_linked as #1301 live train-link

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, #1301 live train-link SHALL be present when the control-host train stream contains a followable `train_loop_linked` event (nonempty child loop run id, absolute events path that loads the linked child inside the approved control-host roots, and a child logical id from that event or the loaded child). The join SHALL resolve that child by the event's validated absolute events path. First-occurrence run-id deduplication across approved roots SHALL NOT choose the child used for train-link validation. The factory-gate pack loop store SHALL NOT be the only allowed source. A `train` entrypoint without that followable child SHALL NOT satisfy #1301. This requirement SHALL NOT invent `train_loop_linked`.

#### Scenario: Followable control-host train_loop_linked satisfies #1301 on in-flight ship

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** a control-host train stream contains a followable `train_loop_linked` event
- **AND** the factory-gate pack loop store has no train events
- **THEN** #1301 live train-link SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase for that live train-link cell

#### Scenario: Train without followable child fails #1301

- **WHEN** in-flight ship FRG scoring observes entrypoint `train`
- **AND** no followable `train_loop_linked` event exists on the control-host train stream
- **THEN** missing required coverage SHALL increase for #1301 live train-link
- **AND** release-eligible pass SHALL be refused

#### Scenario: Duplicate run id in an earlier approved root does not drop a followable control-host train link

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** a control-host train stream contains a followable `train_loop_linked` event
- **AND** an earlier approved root contains a different artifact with the same child run id
- **AND** that event's absolute events path loads the linked child inside a later approved root
- **THEN** #1301 live train-link SHALL be treated as present
- **AND** missing required coverage SHALL NOT increase for that live train-link cell

---

### Requirement: In-flight ship #1333 attach SHALL succeed on a live from-run score when the commit-bound inventory at the scored SHA is complete

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL attach binder-accepted `executed_matrix_rows` for the five required #1333 lifecycle classes from the commit-bound fault-recovery inventory blob at the scored candidate SHA when that inventory-completeness guard passes. Checkout HEAD of the scoring worktree MAY differ from that SHA. A live `factory-gate --from-run` / `defaultScoreBoundPackLoop` score SHALL attach those rows when the blob at the scored SHA is complete. Scoring SHALL NOT stamp helper `covered_lifecycle_classes` lists. An unreadable, incomplete, or other-SHA blob SHALL NOT attach rows. Standalone factory-gate scoring SHALL NOT mint inventory rows.

#### Scenario: Live from-run attaches #1333 rows when HEAD differs from the scored SHA

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C` from a pack-loop `--from-run`
- **AND** the scoring worktree HEAD is not `C`
- **AND** the commit-bound inventory blob at `C` passes the inventory-completeness guard
- **THEN** scored evidence `executed_matrix_rows` SHALL be nonempty and bound to `C`
- **AND** unique-operation evidence SHALL cover lifecycle classes `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown`
- **AND** helper `covered_lifecycle_classes` stamps SHALL NOT populate that coverage

#### Scenario: Incomplete blob on live from-run stays fail-closed

- **WHEN** in-flight ship unique-operation scoring runs for candidate SHA `C` from a pack-loop `--from-run`
- **AND** the commit-bound inventory blob at `C` fails the inventory-completeness guard
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase for uncovered #1333 classes

---

## MODIFIED Requirements

### Requirement: In-flight ship FRG scoring SHALL attach candidate-bound #1333 executed rows from a complete matrix inventory

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL attach `executed_matrix_rows` bound to the scored candidate SHA from the candidate tree's fault-recovery matrix inventory when the inventory-completeness guard passes for that tree. Those rows SHALL feed `covered_lifecycle_classes` through the existing executed-row binder. Scoring SHALL load that inventory from the git object at the scored SHA. Checkout HEAD MAY differ from that SHA. Scoring SHALL NOT stamp helper `covered_lifecycle_classes` lists. An incomplete inventory SHALL NOT attach rows. Standalone factory-gate scoring SHALL NOT mint inventory rows. Absence of durable executed rows on standalone factory-gate SHALL fail as missing required coverage.

#### Scenario: Complete inventory covers all five #1333 classes for the scored SHA

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard passes
- **THEN** unique-operation evidence SHALL cover lifecycle classes `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown` from inventory rows bound to `C`
- **AND** helper `covered_lifecycle_classes` stamps SHALL NOT populate that coverage

#### Scenario: Incomplete inventory does not mint #1333 coverage

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard fails
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase for uncovered #1333 classes

#### Scenario: Standalone factory-gate does not mint inventory rows

- **WHEN** standalone factory-gate unique-operation scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase

#### Scenario: Checkout HEAD mismatch does not refuse a complete blob at the scored SHA

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the scoring worktree HEAD is not `C`
- **AND** the commit-bound inventory blob at `C` passes the inventory-completeness guard
- **THEN** scoring SHALL attach inventory rows bound to `C`
- **AND** those rows SHALL feed the five required #1333 lifecycle classes
