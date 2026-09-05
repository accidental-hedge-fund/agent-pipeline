## ADDED Requirements

### Requirement: Public single, merge, and merge-queue persist SHALL land in the unique-operation collection dual-root

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` SHALL persist the recognizable run artifact into the same dual-root pair unique-operation collection scores: the control-host generic run store used for train, advance, and merge, and the loop state-home runs root. Persist SHALL use the factory-control generic store when that root is known. Persist SHALL NOT write only to a candidate-worktree run store that collection does not read and then treat that write as unique-operation coverage. When the factory-control generic store is unknown, the public command MAY still run, and unique-operation coverage SHALL stay fail-closed for those entrypoints. Collection SHALL NOT invent a unique-operation success from a persist that landed outside the approved roots.

#### Scenario: Persist into the factory-control generic store is observed

- **WHEN** an operator admits `pipeline single 42` and the factory-control generic store is known
- **THEN** that generic store SHALL contain a run artifact whose mapped public entrypoint is `single`
- **AND** in-flight ship unique-operation scoring that reads the dual-root pair SHALL observe `single`

#### Scenario: Persist only into a candidate worktree is not coverage

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **AND** the only persisted artifact lands under a candidate-worktree run store that is not an approved collection root
- **AND** the approved dual-root pair has no recognizable `merge` artifact
- **THEN** entrypoint coverage SHALL NOT observe `merge`
- **AND** missing required coverage SHALL increase for `merge`

#### Scenario: Unknown factory-control root stays fail-closed

- **WHEN** an operator admits `pipeline merge-queue`
- **AND** the factory-control generic store is unknown
- **THEN** unique-operation scoring SHALL NOT observe `merge-queue` from a candidate-worktree persist
- **AND** missing required coverage SHALL increase for `merge-queue` until a real artifact exists in an approved root

---

## MODIFIED Requirements

### Requirement: Public single, merge, and merge-queue admissions SHALL persist recognizable control-host run artifacts

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` SHALL persist a control-host run artifact that unique-operation mapping can observe. That artifact SHALL land in the dual-root pair unique-operation collection scores. That artifact SHALL carry a recognized `run.json.kind`, a `run_start.entrypoint`, command identity, or a documented run-id prefix (`single-`, `merge-`, `merge-queue-` / `mq-`). Nested child loop or train work SHALL remain a distinct mapped entrypoint and SHALL NOT replace the parent admission. Numeric drive (`<issue>-<timestamp>`) SHALL remain `drive`. Unrecognized `kind` values such as `advance` SHALL NOT become `single`. Nested `train_merge_*` events SHALL NOT count as a public `merge` or `merge-queue` admission. Collection SHALL NOT invent a unique-operation success when those artifacts are absent from the approved roots.

#### Scenario: Single admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline single 42`
- **THEN** the control-host run store that unique-operation collection scores SHALL contain a run artifact whose mapped public entrypoint is `single`
- **AND** a nested loop child of that admission SHALL remain mapped as `loop` when a loop artifact exists

#### Scenario: Merge admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **THEN** the control-host run store that unique-operation collection scores SHALL contain a run artifact whose mapped public entrypoint is `merge`

#### Scenario: Merge-queue admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge-queue`
- **THEN** the control-host run store that unique-operation collection scores SHALL contain a run artifact whose mapped public entrypoint is `merge-queue`

#### Scenario: Nested train merge is not a public merge admission

- **WHEN** a train stream contains `train_merge_attempted` or `train_merge_proven`
- **AND** no public `pipeline merge` or `pipeline merge-queue` run artifact exists in the approved dual-root pair
- **THEN** entrypoint coverage SHALL NOT observe `merge` or `merge-queue` from those nested train events

#### Scenario: Absent artifacts stay fail-closed

- **WHEN** unique-operation scoring collects attempts from the control-host stores
- **AND** no recognizable `single`, `merge`, or `merge-queue` run artifact exists in the approved dual-root pair
- **THEN** missing required coverage SHALL increase for each missing entrypoint
- **AND** scoring SHALL NOT mint a synthetic success for those entrypoints

### Requirement: Live train-link SHALL increment from a followable train_loop_linked event

Unique-operation aggregation SHALL treat #1301 live train-link as present when a control-host train attempt has a `train_loop_linked` event that is followable. Followable SHALL mean: a nonempty child loop run id, a nonempty absolute events path that loads the linked child inside the approved control-host runs roots, and a child logical id inherited from the parent train operation. The join SHALL resolve the linked child by that event's validated absolute events path. First-occurrence run-id deduplication across approved roots SHALL NOT choose the child used for train-link validation. The join SHALL require that absolute events path to equal the loaded child's events-file path. The join SHALL use the loaded child's minted logical id when that minted id differs from the train identity. The join SHALL use the event's `logical_operation_id` when present and the child minted id is absent or equals the train identity. The join SHALL inherit the parent train logical id as the child logical id when the event and the loaded child omit a minted logical id. The scored train operation SHALL carry that followable child logical id. The join SHALL NOT require the child's `run_id` fallback identity to equal the train minted id. A distinct child minted id SHALL NOT increment contradictory correlation solely as a failed train-link join. A `train` entrypoint without a followable child SHALL NOT count as live train-link. Observing entrypoint `train` alone SHALL NOT satisfy the live train-link cell. A path that escapes the approved roots SHALL NOT count. Collection SHALL NOT invent `train_loop_linked`.

#### Scenario: Followable train_loop_linked increments live train-link

- **WHEN** a control-host train run has a `train_loop_linked` event with nonempty `loop_run_id` `L`
- **AND** that event's events path is absolute and loads a child inside the approved control-host roots
- **AND** the parent train, the event, or the loaded child supplies a child logical id
- **THEN** live train-link SHALL be present
- **AND** the scored train operation SHALL carry that followable child logical id
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link

#### Scenario: Parent logical id is inherited when event and child omit a minted id

- **WHEN** a control-host train run has minted logical identity `T`
- **AND** a followable `train_loop_linked` child is loadable at an absolute events path inside the approved roots
- **AND** the event has no `logical_operation_id`
- **AND** the child artifact has no minted logical id
- **THEN** the scored train operation SHALL carry child logical id `T`
- **AND** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link

#### Scenario: Child run_id fallback mismatch does not drop a followable link

- **WHEN** a control-host train run has minted logical identity `T`
- **AND** a followable `train_loop_linked` child is loadable at an absolute events path inside the approved roots
- **AND** the child artifact has no minted logical id and uses `run_id` fallback `loop-1`
- **THEN** live train-link SHALL still be present
- **AND** that fallback mismatch SHALL NOT increment contradictory correlation solely as a failed train-link join

#### Scenario: Train without a followable child does not count

- **WHEN** unique-operation scoring observes entrypoint `train`
- **AND** that train attempt has no `train_loop_linked` event with a nonempty loop run id and absolute events path that loads inside the approved roots
- **THEN** live train-link SHALL NOT be present
- **AND** missing required coverage SHALL increase for #1301 when `train` is a required entrypoint

#### Scenario: Observing train alone does not satisfy live train-link

- **WHEN** unique-operation scoring observes entrypoint `train`
- **AND** a `train_loop_linked` event exists
- **AND** the scored train operation does not carry a followable child logical id inherited from the parent
- **THEN** live train-link SHALL NOT be present
- **AND** missing required coverage SHALL increase for #1301 when `train` is a required entrypoint

#### Scenario: Escaping child path does not count

- **WHEN** a train `train_loop_linked` events path resolves outside the approved control-host runs roots
- **THEN** that event SHALL NOT count as live train-link

#### Scenario: Unrelated in-root events path does not count

- **WHEN** a train `train_loop_linked` event names an absolute events path inside the approved roots
- **AND** a child artifact exists for that `loop_run_id` at a different events-file path
- **THEN** that event SHALL NOT count as live train-link

#### Scenario: Duplicate run id in an earlier approved root does not drop a path-matched child

- **WHEN** a control-host train run has a `train_loop_linked` event with nonempty `loop_run_id` `L`
- **AND** an earlier approved root contains a different artifact with run id `L`
- **AND** that event's absolute events path loads the linked child inside a later approved root
- **AND** the parent train, the event, or the loaded child supplies a child logical id
- **THEN** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link

#### Scenario: Child minted logical id without event logical id still counts

- **WHEN** a control-host train run has minted logical identity `T`
- **AND** a followable `train_loop_linked` child is loadable at an absolute events path inside the approved roots
- **AND** the child artifact has minted logical id `C` different from `T`
- **AND** the event has no `logical_operation_id`
- **THEN** live train-link SHALL be present
- **AND** missing required coverage SHALL NOT increase for #1301 live train-link
- **AND** that distinct child minted id SHALL NOT increment contradictory correlation solely as a failed train-link join
