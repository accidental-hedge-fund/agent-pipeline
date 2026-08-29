## MODIFIED Requirements

### Requirement: Agent Pipeline SHALL be the sole authoritative durable state engine for loop runs

Agent Pipeline SHALL implement the durable multi-item orchestration engine in-repo and SHALL
NOT invoke, discover, read, or depend on an externally installed goal-loop skill on any
execution path. No second ledger, second run-id namespace, second lock, or second run
directory SHALL be authoritative for a run. The engine SHALL live in a dedicated module and
SHALL NOT be reachable from the per-item advance state machine, which continues to own
exactly one issue at a time.

#### Scenario: A loop run needs no external skill installed

- **WHEN** `pipeline loop` is invoked on a host with no goal-loop skill present at any
  install root
- **THEN** the run SHALL compile a contract, initialize, lock, and report a run id
- **AND** no install-remediation failure SHALL be produced on any path

#### Scenario: No external engine invocation remains

- **WHEN** the engine's code paths are inspected
- **THEN** they SHALL contain no subprocess invocation of an external goal-loop CLI and no
  read of an external goal-loop install manifest or source file, other than the documented
  legacy-run import path

#### Scenario: The advance state machine cannot drive the engine

- **WHEN** the per-item advance stages are inspected
- **THEN** none SHALL import or call an engine operation that transitions a loop item
