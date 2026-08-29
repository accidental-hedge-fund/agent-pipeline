## ADDED Requirements

### Requirement: Pack-loop dispatch SHALL acknowledge the child from loop_run_handoff

A factory-release pack-loop dispatcher SHALL treat a typed `loop_run_handoff` as the dispatch acknowledgement. The child SHALL emit that handoff after it acquires the exclusive lock for the exact loop. The dispatcher SHALL validate the handoff `run_id` against the bound `loop_run_id`, SHALL require absolute `run_dir` and `events` paths under the durable loop store, and SHALL require a matching `supervisor.json` process identity (PID, process-start identity, boot identity) for that loop. OS accept of the child process SHALL NOT be that acknowledgement. The dispatcher SHALL persist request binding as bound before spawn and SHALL persist dispatched only after that validation succeeds.

#### Scenario: Handoff marks dispatched

- **WHEN** the pack child acquires the exclusive lock for bound loop `L`
- **AND** it emits `kind: "loop_run_handoff"` with `run_id` `L`, absolute `run_dir` and `events`, and matching `supervisor.json` process identity
- **THEN** the dispatcher SHALL persist `dispatch_state` `dispatched` for `L`
- **AND** it SHALL NOT have persisted `dispatched` solely because the OS accepted the child

#### Scenario: OS accept is not acknowledgement

- **WHEN** the OS reports spawn success for the pack child
- **AND** no valid `loop_run_handoff` for that `loop_run_id` has been observed
- **THEN** the binding SHALL remain `bound`
- **AND** the dispatcher SHALL NOT treat the loop as dispatched

#### Scenario: Mismatched handoff is rejected

- **WHEN** a handoff `run_id` does not equal the bound `loop_run_id`
- **OR** `run_dir` or `events` is not an absolute store path
- **OR** `supervisor.json` process identity does not match that handoff
- **THEN** the dispatcher SHALL NOT persist `dispatched`
- **AND** it SHALL fail closed with a typed identity error
