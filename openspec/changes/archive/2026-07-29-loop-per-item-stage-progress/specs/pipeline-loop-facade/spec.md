## ADDED Requirements

### Requirement: `pipeline:loop --audit` SHALL print the per-item stage-progress table

The `pipeline:loop` facade's `--audit` mode SHALL print a human-readable per-item stage-progress table (or equivalent structured section) for the resolved durable loop run. Each row SHALL include the item id, a current-stage presentation (or clear queued/pending presentation), and the advance run-id when known so an operator can invoke `pipeline logs <advance-run-id> --follow`. Audit SHALL remain read-only and SHALL NOT start or resume a mutating supervisor cycle solely because the stage table is rendered.

#### Scenario: Audit CLI output names stage and advance run id

- **WHEN** `pipeline:loop --audit` (with `--resume <run-id>` when required to select the run) succeeds for a run where item `607` is `implementing` with advance run id `607-2026-07-27T19-31-29-328Z`
- **THEN** stdout SHALL include the item identifier, the stage presentation `implementing`, and the advance run id `607-2026-07-27T19-31-29-328Z`

#### Scenario: Audit does not start the run

- **WHEN** `pipeline:loop --audit` prints the stage table
- **THEN** it SHALL perform no ledger mutation, no lock acquisition for driving the run, and no GitHub mutation

---

### Requirement: `pipeline:loop` SHALL accept a documented read-only stage-progress follow path

The `pipeline:loop` argument contract SHALL accept a documented observation combination that follows whole-run stage-progress events as clean one-line output. At least one of the following SHALL be supported and documented: `--audit --follow`, or an observation-only follow mode that targets an existing run id without requiring the operator to manually `tail` files. The follow path SHALL stream stage transitions (item id, stage, optional round, advance run-id when known) and SHALL NOT primarily re-emit interleaved per-item harness terminal prose. The follow path SHALL be classified read-only for lock/reservation purposes.

#### Scenario: Documented follow path is accepted by argument normalization

- **WHEN** `pipeline:loop` is invoked with the documented stage-progress follow combination for an existing run
- **THEN** argument normalization SHALL accept the combination rather than rejecting `--follow` as an unknown flag
- **AND** the invocation SHALL be classified as read-only observation (no run-liveness reservation)

#### Scenario: Follow output is stage progress, not harness stdout

- **WHEN** the documented follow path streams while a stage transition is recorded for item `607`
- **THEN** the emitted line SHALL include item `607` and the new stage
- **AND** SHALL NOT be a passthrough of the child advance harness's interleaved terminal prose

#### Scenario: Mutating resume remains unambiguous

- **WHEN** `pipeline:loop --resume <run-id>` is invoked without the observation follow combination
- **THEN** existing resume/drive semantics SHALL remain unchanged
- **AND** the addition of the follow observation path SHALL NOT silently disable or dual-purpose a mutating resume without documentation
