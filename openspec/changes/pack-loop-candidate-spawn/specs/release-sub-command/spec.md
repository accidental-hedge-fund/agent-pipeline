## ADDED Requirements

### Requirement: Factory-release pack-loop spawn SHALL use the candidate invocation that wrote the contract

`pipeline factory-release prepare` SHALL spawn or resume the request-bound pack loop with the same verified candidate invocation that wrote that loop's contract. The invocation SHALL include the absolute candidate executable, argv, and candidate SHA. PATH `pipeline` and `PIPELINE_BIN` SHALL NOT be production fallbacks for that child. `--engine-track candidate` SHALL remain on the child argv as intent metadata and SHALL NOT select the binary. The command SHALL persist `loop_run_id` and the matching request binding as bound before spawn. It SHALL persist dispatched only after a valid `loop_run_handoff` for that `loop_run_id`. A failed OS spawn (child never started) SHALL fail that tick and SHALL leave the request bound to the same `loop_run_id` so a later invoke can retry spawn. A child that exits non-zero before the first valid handoff SHALL fail that tick closed and SHALL NOT be retried as a second blind spawn.

#### Scenario: Prepare pack child is the candidate engine

- **WHEN** pin SHA `P` ≠ candidate SHA `C`
- **AND** candidate prepare dispatches the pack loop
- **THEN** the child executable SHALL be the resolved candidate launcher for `C`
- **AND** it SHALL NOT be PATH `pipeline` or pin `P`

#### Scenario: Binding stays bound until handoff

- **WHEN** prepare has persisted `loop_run_id` `L` and a matching binding
- **AND** the OS has accepted the child
- **AND** no valid `loop_run_handoff` for `L` has been observed
- **THEN** `dispatch_state` SHALL remain `bound`
- **AND** a later invoke of the unchanged request SHALL reconcile `L` instead of minting a second loop

#### Scenario: Pre-handoff child exit fails closed

- **WHEN** the pack child exits non-zero before a valid `loop_run_handoff`
- **THEN** that prepare tick SHALL NOT return `status: "in_progress"` as if the loop were running
- **AND** it SHALL NOT persist `dispatch_state` `dispatched`
- **AND** it SHALL NOT blindly spawn a second child for a new `loop_run_id`
