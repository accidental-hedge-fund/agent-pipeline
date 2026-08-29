## MODIFIED Requirements

### Requirement: Loop orchestration docs SHALL specify handoff, follow, notify, stop, and summarize

The shared orchestration-contract source and each generated host SKILL SHALL specify an ordered harness follow/notify protocol for `pipeline loop` drive and resume: capture `run_id` from the durable handoff, follow `pipeline loop logs --events --follow`, stop on a terminal loop event (`loop_run_complete` or `loop_run_stopped`), and emit a final summary. Generated SKILLs SHALL NOT be required to contain §4b state-home discovery bash or dual-follow FIFO scripts. The follower SHALL NOT invoke a merge-capable command. Read-only `--audit` MAY remain a short synchronous mode in `docs/cli.md`.

#### Scenario: Ordered steps are present in host skill guidance

- **WHEN** an operator reads the generated SKILL or the shared orchestration-contract source
- **THEN** the text SHALL list capture `run_id`, `pipeline loop logs --events --follow`, stop on terminal, and final summary as ordered steps
- **AND** SHALL NOT instruct the follower to invoke `merge`, `merge-queue --apply`, `train --merge`, or `ship`

#### Scenario: SKILL omits the discovery bash essay

- **WHEN** a generated host SKILL is read
- **THEN** it SHALL NOT contain §4b state-home discovery bash
- **AND** it SHALL NOT contain dual-follow FIFO scripts

#### Scenario: New drive obtains run_id before completion without early handoff

- **WHEN** a harness starts a new multi-item drive and no early handoff is present
- **THEN** the follow/notify contract SHALL instruct the harness to capture `run_id` from the durable handoff before stop
- **AND** SHALL NOT instruct relying solely on a later chat guess for the follow target

#### Scenario: Optional item-advance follow is not required before linkage exists

- **WHEN** no advance `run_id` has been published for the active item
- **THEN** the harness SHALL still follow the loop event stream
- **AND** the contract SHALL NOT require a non-existent advance-linkage field

#### Scenario: Stop step requires same-turn teardown

- **WHEN** a terminal loop outcome (`loop_run_stopped`) or supervisor exit occurs
- **THEN** the follow/notify contract SHALL require ending run-scoped follows in the same turn
- **AND** the subsequent summary SHALL include terminal reason and follows-stopped confirmation
