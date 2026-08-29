## ADDED Requirements

### Requirement: Pack-loop dispatch SHALL acknowledge the child from loop_run_handoff

A factory-release pack-loop dispatcher SHALL treat a typed `loop_run_handoff` as the dispatch acknowledgement. The child SHALL emit that handoff after it acquires the exclusive lock for the exact loop. The acknowledgement SHALL be durable and atomic on the run directory (`loop-run-handoff.json` written through the store atomic seam, token-guarded) so a detached or restarted parent can reconcile it. Live stdout JSON MAY still be emitted for harness follow. The dispatcher SHALL validate the handoff `run_id` against the bound `loop_run_id`, SHALL require `candidate_sha` to equal the frozen candidate invocation SHA, SHALL require `run_dir` and `events` to be absolute paths whose realpaths are contained in the durable loop store run directory, and SHALL require a matching `supervisor.json` process identity (PID, process-start identity, boot identity) for that loop. OS accept of the child process SHALL NOT be that acknowledgement. The dispatcher SHALL persist request binding as `bound` before spawn, SHALL persist `starting` after OS accept with an observation deadline, and SHALL persist `dispatched` only after that validation succeeds.

#### Scenario: Handoff marks dispatched

- **WHEN** the pack child acquires the exclusive lock for bound loop `L`
- **AND** it writes durable `kind: "loop_run_handoff"` with `run_id` `L`, `candidate_sha` matching the invocation, realpath-contained `run_dir` and `events`, and matching `supervisor.json` process identity
- **THEN** the dispatcher SHALL persist `dispatch_state` `dispatched` for `L`
- **AND** it SHALL NOT have persisted `dispatched` solely because the OS accepted the child

#### Scenario: OS accept is not acknowledgement

- **WHEN** the OS reports spawn success for the pack child
- **AND** no valid `loop_run_handoff` for that `loop_run_id` has been observed
- **THEN** the binding SHALL be `starting`, not `dispatched`
- **AND** the dispatcher SHALL NOT treat the loop as dispatched

#### Scenario: Detached parent still reconciles the durable handoff

- **WHEN** the prepare parent has detached or exited after OS accept
- **AND** the child has written a valid `loop-run-handoff.json`
- **THEN** a later invoke of the same request SHALL observe that handoff
- **AND** it SHALL persist `dispatch_state` `dispatched` without spawning a second child

#### Scenario: Mismatched handoff is rejected

- **WHEN** a handoff `run_id` does not equal the bound `loop_run_id`
- **OR** `candidate_sha` does not equal the frozen candidate invocation SHA
- **OR** `run_dir` or `events` is not an absolute realpath-contained store path
- **OR** `supervisor.json` process identity does not match that handoff
- **THEN** the dispatcher SHALL NOT persist `dispatched`
- **AND** it SHALL persist `dispatch_state` `failed`
- **AND** it SHALL fail closed with a typed identity error
