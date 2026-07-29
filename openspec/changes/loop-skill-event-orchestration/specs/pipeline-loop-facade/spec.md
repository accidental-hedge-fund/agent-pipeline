## ADDED Requirements

### Requirement: Host packaging for `pipeline:loop` SHALL describe durable runs as long-running and event-followed

The facade’s host packaging (generated `pipeline:loop` command docs and host skill guidance for Claude and Codex) SHALL describe multi-item durable drive and resume as long-running work that harnesses follow via the loop event stream. The packaging SHALL NOT instruct harnesses to treat drive/resume as a seconds-only synchronous command that needs no Monitor. This requirement is packaging and operator-orchestration only; it does not change preflight order, contract compilation, per-item execution through `pipeline/loop-execution@1`, or the facade’s refusal to merge.

#### Scenario: Drive packaging points at event following

- **WHEN** a harness reads the generated `pipeline:loop` command body for a
  multi-item drive or resume
- **THEN** the body SHALL NOT claim the run completes in seconds with no Monitor
- **AND** the body SHALL instruct long-running orchestration or point to the host
  skill’s loop event-following protocol

#### Scenario: Facade execution rules remain unchanged

- **WHEN** this packaging requirement is applied
- **THEN** selected items SHALL still execute through the unmodified Pipeline
  state machine and evidence gates
- **AND** the facade SHALL still perform no merge
