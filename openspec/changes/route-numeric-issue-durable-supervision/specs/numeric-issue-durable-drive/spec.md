## Purpose

Makes mutating default numeric issue drive a compatibility alias for the canonical one-item durable supervisor, and keeps raw stage advancement as a non-recursive internal executor.

## ADDED Requirements

### Requirement: Mutating numeric invocation SHALL alias to the one-item durable supervisor

Every mutating `pipeline <N>` invocation SHALL be a compatibility alias for the canonical one-item durable supervisor used by `pipeline single <N>`. Invocation syntax SHALL NOT change lifecycle ownership. Mutating numeric invocation and `pipeline single <N>` SHALL create or attach to the same durable run model: the same supervisor, recovery policy, attempt ledger, and terminal event contract. Mutating numeric invocation SHALL NOT call raw stage advancement as its top-level lifecycle owner. Numeric, single, and loop SHALL still never merge or deploy.

#### Scenario: Numeric drive and single share one supervisor

- **WHEN** an operator invokes mutating `pipeline <N>` for a positive issue number
- **THEN** the CLI SHALL create or attach to the same one-item durable run that `pipeline single <N>` would use
- **AND** recovery, cooling, and terminal events SHALL be supervisor-owned
- **AND** the invocation SHALL NOT call raw stage advancement as the top-level lifecycle owner

#### Scenario: Invocation syntax does not select a raw-advance owner

- **WHEN** a contract test compares mutating `pipeline <N>` with `pipeline single <N>` for the same issue and options that remain valid child inputs
- **THEN** both SHALL enter the same durable supervisor lifecycle
- **AND** a fixture that treats numeric syntax as a direct raw-advance owner SHALL fail

#### Scenario: Numeric, single, and loop never merge

- **WHEN** mutating `pipeline <N>`, `pipeline single <N>`, or `pipeline loop` reaches `pipeline:ready-to-deploy`
- **THEN** the run SHALL stop without invoking merge, merge-queue apply, train merge, or ship

---

### Requirement: Public numeric drive SHALL emit one canonical loop-run handoff

Public mutating `pipeline <N>` SHALL emit one canonical loop-run handoff whose `run_id` is the durable loop identity. Child advance identity SHALL be published only through the typed linkage event (`loop_item_advance_linked` or the equivalent start-linkage record). Public mutating numeric invocation SHALL NOT emit a second top-level `advance_run_handoff` as its canonical run identity. Durable run identity and recovery evidence SHALL be emitted consistently with `pipeline single`.

#### Scenario: Numeric stdout matches the single handoff contract

- **WHEN** mutating `pipeline <N>` starts a durable one-item run
- **THEN** it SHALL emit the canonical loop-run handoff
- **AND** a host SHALL retain that `run_id` as `loop_run_id`
- **AND** it SHALL NOT emit a top-level `advance_run_handoff` for that public invocation

#### Scenario: Child advance identity is linkage-only

- **WHEN** the one-item supervisor dispatches whole-item advancement
- **THEN** the child advance run identity SHALL appear on the loop trail through the typed linkage event
- **AND** hosts SHALL follow that linked advance only after linkage
- **AND** they SHALL NOT infer the advance identity from the public numeric argv

---

### Requirement: Nested child advancement SHALL use a non-public adapter that cannot recurse

Raw stage advancement SHALL remain an internal executor operation. Nested whole-item advancement from the durable supervisor (`pipeline/loop-execution@1` children, in-process recover-parked re-entry, and equivalent nested re-entry) SHALL use an explicit non-public adapter path. That adapter SHALL NOT recursively create or attach to another durable supervisor. The nested path SHALL NOT be a public mutating `pipeline <N>` admission. Generated host skills and advertised CLI help SHALL NOT recommend that nested path as an operator issue drive.

#### Scenario: Nested child does not mint a second supervisor

- **WHEN** the one-item or multi-item supervisor dispatches a nested whole-item advancement
- **THEN** the nested path SHALL use the non-public adapter
- **AND** it SHALL NOT create or attach to a second durable supervisor
- **AND** a fixture that re-enters public mutating `pipeline <N>` as that nested child SHALL fail

#### Scenario: Nested adapter is not a public bypass

- **WHEN** generated host SKILLs, advertised help, and the command verb table are inspected
- **THEN** they SHALL NOT recommend the nested adapter as an operator issue-drive command
- **AND** they SHALL still retain `pipeline <N>` as the public default drive syntax

---

### Requirement: Read-only and mode-selector forms SHALL dispatch before aliasing

The CLI SHALL preserve read-only and mode-selector forms on a numeric first argument before it aliases mutating drive to the one-item supervisor. Those forms include `--status`, `--summary`, `--unblock`, `--override`, `--remove-worktree`, and flag-only `--cleanup` / `--init`. `--detach` SHALL detach the same one-item supervisor rather than a raw-advance owner. Stage-specific compatibility flags (`--once`, `--dry-run`, `--model`, `--run-id`, `--engine-track`, and equivalent advance-loop inputs) SHALL become immutable child inputs to nested advancement. They SHALL NOT select a different top-level lifecycle owner.

#### Scenario: Status on a numeric argument stays read-only

- **WHEN** the operator invokes `pipeline <N> --status` or `pipeline <N> --status --json`
- **THEN** the CLI SHALL dispatch the status form
- **AND** it SHALL NOT start the one-item supervisor or raw stage advancement

#### Scenario: Detach launches the same one-item supervisor

- **WHEN** the operator invokes `pipeline <N> --detach` or `pipeline run <N> --detach`
- **THEN** the detached child SHALL be the same one-item durable supervisor used by `pipeline single <N>`
- **AND** it SHALL NOT detach a raw-advance owner

#### Scenario: Once remains a child input

- **WHEN** the operator invokes mutating `pipeline <N> --once`
- **THEN** the CLI SHALL still enter the one-item durable supervisor
- **AND** `--once` SHALL be passed as an immutable child input to nested advancement
- **AND** `--once` SHALL NOT select raw stage advancement as the top-level owner

---

### Requirement: Mechanical failure through numeric invocation SHALL remain supervisor-owned

A mechanical fault, timeout, process exit, or uncertain side effect observed through mutating `pipeline <N>` SHALL remain RecoverySupervisor-owned. The invocation SHALL NOT convert that fault into human authority, a completed Logical Operation, or a cancelled operation solely because the operator used numeric syntax. Durable recovery evidence SHALL be recorded on the same run model as `pipeline single`.

#### Scenario: Numeric mechanical fault stays owned

- **WHEN** mutating `pipeline <N>` observes a mechanical fault during one-item drive
- **THEN** RecoverySupervisor SHALL retain ownership
- **AND** the observation SHALL NOT mark the Logical Operation complete, cancelled, or human-owned solely for that fault

#### Scenario: Recovery evidence matches single

- **WHEN** the same mechanical fault is observed through `pipeline <N>` and through `pipeline single <N>`
- **THEN** both SHALL record recovery evidence on the one-item durable run
- **AND** hosts SHALL follow that evidence through the canonical loop identity
