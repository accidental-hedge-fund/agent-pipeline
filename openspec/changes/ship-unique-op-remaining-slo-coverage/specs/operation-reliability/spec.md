## ADDED Requirements

### Requirement: Public single, merge, and merge-queue admissions SHALL persist recognizable control-host run artifacts

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue` SHALL persist a control-host run artifact that unique-operation mapping can observe. That artifact SHALL carry a recognized `run.json.kind`, a `run_start.entrypoint`, or a documented run-id prefix (`single-`, `merge-`, `merge-queue-` / `mq-`). Nested child loop or train work SHALL remain a distinct mapped entrypoint and SHALL NOT replace the parent admission. Numeric drive (`<issue>-<timestamp>`) SHALL remain `drive`. Unrecognized `kind` values such as `advance` SHALL NOT become `single`. Nested `train_merge_*` events SHALL NOT count as a public `merge` or `merge-queue` admission. Collection SHALL NOT invent a unique-operation success when those artifacts are absent.

#### Scenario: Single admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline single 42`
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `single`
- **AND** a nested loop child of that admission SHALL remain mapped as `loop` when a loop artifact exists

#### Scenario: Merge admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `merge`

#### Scenario: Merge-queue admission persists a recognizable artifact

- **WHEN** an operator admits `pipeline merge-queue`
- **THEN** the control-host run store SHALL contain a run artifact whose mapped public entrypoint is `merge-queue`

#### Scenario: Nested train merge is not a public merge admission

- **WHEN** a train stream contains `train_merge_attempted` or `train_merge_proven`
- **AND** no public `pipeline merge` or `pipeline merge-queue` run artifact exists
- **THEN** entrypoint coverage SHALL NOT observe `merge` or `merge-queue` from those nested train events

#### Scenario: Absent artifacts stay fail-closed

- **WHEN** unique-operation scoring collects attempts from the control-host stores
- **AND** no recognizable `single`, `merge`, or `merge-queue` run artifact exists
- **THEN** missing required coverage SHALL increase for each missing entrypoint
- **AND** scoring SHALL NOT mint a synthetic success for those entrypoints

---

### Requirement: Live train-link SHALL increment from a followable train_loop_linked event

Unique-operation aggregation SHALL treat #1301 live train-link as present when a control-host train attempt has a `train_loop_linked` event that is followable. Followable SHALL mean: a nonempty child loop run id, a nonempty absolute events path that loads a child inside the approved control-host runs roots, and a child logical id from that event or from the loaded child. The join SHALL use the event's `logical_operation_id` as the inherited child logical id when the child artifact has no minted logical id or when the child's minted id equals the train identity. The join SHALL NOT require the child's `run_id` fallback identity to equal the train minted id. A `train` entrypoint without a followable child SHALL NOT count as live train-link. A path that escapes the approved roots SHALL NOT count. Collection SHALL NOT invent `train_loop_linked`.

#### Scenario: Followable train_loop_linked increments live train-link

- **WHEN** a control-host train run has a `train_loop_linked` event with nonempty `loop_run_id` `L`
- **AND** that event's events path is absolute and loads a child inside the approved control-host roots
- **AND** the event or loaded child supplies a child logical id
- **THEN** live train-link SHALL be present
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

#### Scenario: Escaping child path does not count

- **WHEN** a train `train_loop_linked` events path resolves outside the approved control-host runs roots
- **THEN** that event SHALL NOT count as live train-link

---

## MODIFIED Requirements

### Requirement: Unique-operation attempt mapping SHALL recognize public entrypoints from durable kind, start event, or run-id prefix

Unique-operation attempt mapping SHALL set a recognized public entrypoint from durable `run.json.kind`, the `run_start.entrypoint` event field, or a stable run-id prefix (`train-`, `loop-`, `single-`, `merge-`, `merge-queue-` / `mq-`, numeric drive). Mapping SHALL NOT coerce unrecognized `kind` values such as `advance` to `single`. When the artifact has no durable `logical_operation_id`, mapping SHALL use `run_id` as the aggregation identity. Mapping SHALL NOT treat pack-issue labels, latest-run lookup, or comment prose as a logical identity. Mapping SHALL NOT count that fallback identity as verified unique-operation success.

#### Scenario: Kind and start-event entrypoints are preferred

- **WHEN** a run artifact has `run_start.entrypoint` `train`
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Train run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `train-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Loop run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `loop-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `loop`

#### Scenario: Single run-id prefix maps when kind and start event are absent

- **WHEN** a run artifact has run-id prefix `single-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `single`

#### Scenario: Merge and merge-queue prefixes are distinct

- **WHEN** a run artifact has run-id prefix `mq-` or `merge-queue-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `merge-queue`

#### Scenario: Numeric drive prefix maps when kind and start event are absent

- **WHEN** a run artifact has a numeric-drive run-id (`<issue>-<timestamp>`)
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `drive`

#### Scenario: Advance kind is not coerced to single

- **WHEN** a run artifact has `run.json.kind` `advance`
- **AND** `run_start.entrypoint` is absent
- **AND** the run-id is not a recognized public-entrypoint prefix
- **THEN** the attempt entrypoint SHALL NOT be `single`

#### Scenario: Unrecognized kind falls through to a matching prefix

- **WHEN** a run artifact has `run.json.kind` `advance`
- **AND** `run_start.entrypoint` is absent
- **AND** the run-id prefix is `train-`
- **THEN** the attempt entrypoint SHALL be `train`

#### Scenario: Merge-queue prefixes are checked before merge

- **WHEN** a run artifact has run-id prefix `merge-queue-` or `mq-`
- **AND** `run.json.kind` and `run_start.entrypoint` are absent
- **THEN** the attempt entrypoint SHALL be `merge-queue`
- **AND** the attempt entrypoint SHALL NOT be `merge`

#### Scenario: Start-event entrypoint wins over kind and prefix

- **WHEN** a run artifact has `run_start.entrypoint` `loop`
- **AND** `run.json.kind` is `train`
- **AND** the run-id prefix is `train-`
- **THEN** the attempt entrypoint SHALL be `loop`

#### Scenario: Missing logical id uses run_id as aggregation identity

- **WHEN** a run artifact has no durable `logical_operation_id`
- **AND** it has a non-empty `run_id`
- **THEN** the attempt aggregation identity SHALL equal that `run_id`
- **AND** the attempt SHALL NOT count as verified unique-operation success
