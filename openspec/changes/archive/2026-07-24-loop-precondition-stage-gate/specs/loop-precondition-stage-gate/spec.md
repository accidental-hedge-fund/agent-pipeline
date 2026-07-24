## ADDED Requirements

### Requirement: A work-list item not at the pipeline-ready precondition SHALL be excluded from the executable frontier with a durable non-fatal precondition rationale

The supervisor SHALL treat `pipeline:ready` (or any later in-flight pipeline stage) as the
admission precondition for dispatching a work-list item. When a run's reconciliation pass
observes an eligible item still at a **pre-pipeline** stage — carrying `pipeline:backlog`
or carrying no `pipeline:*` label at all — the supervisor SHALL exclude that item from the
set of items it dispatches this cycle and SHALL record a durable, **non-fatal**
`precondition` exclusion rationale naming the excluded item, the required stage
(`pipeline:ready`), and the observed pre-pipeline stage. The exclusion SHALL NOT be a
`blocked` transition, SHALL NOT consume any recovery budget, and SHALL NOT set, record, or
count toward any run stop. The gate SHALL be evaluated against live truth on each
reconciliation pass, so an item triaged from a pre-pipeline stage to `pipeline:ready`
mid-run becomes admissible on a later cycle without recompiling or restarting the run. The
decision SHALL be a deterministic function of the observed live stage so a unit test drives
it with no real network, git, or subprocess call.

#### Scenario: A backlog item is excluded, not dispatched

- **WHEN** an eligible work-list item is observed still carrying `pipeline:backlog`
- **THEN** the supervisor SHALL NOT dispatch that item this cycle
- **AND** it SHALL record a non-fatal `precondition` exclusion naming the item, the required
  stage `pipeline:ready`, and the observed stage `pipeline:backlog`
- **AND** the exclusion SHALL NOT consume any recovery budget and SHALL NOT record a run stop

#### Scenario: An item with no pipeline label is treated as pre-pipeline

- **WHEN** an eligible work-list item is observed carrying no `pipeline:*` label
- **THEN** the supervisor SHALL exclude it with the same non-fatal `precondition` rationale
  naming the required stage `pipeline:ready`

#### Scenario: A ready item alongside a backlog item still advances

- **WHEN** a run's frontier contains one item at `pipeline:ready` and one item at
  `pipeline:backlog`
- **THEN** the supervisor SHALL dispatch the `pipeline:ready` item
- **AND** SHALL exclude the `pipeline:backlog` item with a `precondition` rationale
- **AND** the run SHALL reach its normal terminal condition without a run stop

#### Scenario: A mid-run triage to ready admits the item on a later cycle

- **WHEN** an item previously excluded at `pipeline:backlog` is observed at `pipeline:ready`
  on a subsequent reconciliation pass
- **THEN** the supervisor SHALL treat it as admissible and eligible for dispatch
- **AND** no run recompilation or restart SHALL be required

---

### Requirement: A pre-pipeline no-op dispatch SHALL NOT be classified as an engine defect or a run-fatal stop

The dispatch-outcome mapping SHALL record a pre-pipeline no-op as a non-fatal `precondition`
exclusion, not as an engine defect. When the per-item dispatch seam runs the advance loop for
an item and the item is left still at a pre-pipeline stage (`pipeline:backlog` or no
`pipeline:*` label) having made zero stage transitions, that outcome SHALL be recorded as the
same non-fatal `precondition` exclusion rather than mapped to the `failed` terminal outcome.
Such an outcome SHALL NEVER be classified under the `workflow-engine-defect` blocker class and
SHALL NEVER record a `run_fatal` stop. A genuine engine defect — a rejected/crashed dispatch, or an outcome
outside the defined terminal set left at no recognizable stage — SHALL remain classified
`failed` / `workflow-engine-defect` with its existing `run_fatal` policy unchanged.

#### Scenario: A zero-transition backlog dispatch is not run-fatal

- **WHEN** an item is dispatched, makes zero stage transitions, and is left at
  `pipeline:backlog`
- **THEN** the outcome SHALL be recorded as a non-fatal `precondition` exclusion
- **AND** it SHALL NOT be classified `workflow-engine-defect`
- **AND** it SHALL NOT record a `run_fatal` stop

#### Scenario: A genuine engine defect is still run-fatal

- **WHEN** a dispatch is rejected/crashes, or reports an outcome outside the defined terminal
  set with the item at no recognizable pipeline stage
- **THEN** the outcome SHALL be classified `workflow-engine-defect`
- **AND** its existing `run_fatal` policy SHALL apply unchanged

#### Scenario: The single-backlog-item run completes without stopping

- **WHEN** a run's only remaining eligible item is at `pipeline:backlog`
- **THEN** the run SHALL reach a terminal condition that is NOT a `run_fatal` stop
- **AND** the `precondition` exclusion for that item SHALL be recorded
