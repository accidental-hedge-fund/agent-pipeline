## MODIFIED Requirements

### Requirement: One-item drives SHALL use the same durable supervisor

The default host-facing single-issue drive SHALL compile a one-item work-list and execute it through
the same durable supervisor, diagnostic projection, recovery policy, attempt ledger, and terminal
event contract as a multi-item drive. Mutating `pipeline <N>` and `pipeline single <N>` SHALL both
be that default host-facing one-item drive. A later invocation SHALL resume an active canonical run and
SHALL mint a linked superseding run only when the canonical chain head is terminally stopped, so an
exhausted ledger is never silently reused as a fresh attempt budget. Nested whole-item advancement
spawned by that supervisor SHALL NOT create or attach to a second durable supervisor.

#### Scenario: A blocked single issue enters recovery before returning

- **WHEN** a host invokes the default pipeline skill for one issue whose current state is blocked
- **THEN** the host SHALL start the durable one-item controller rather than a detached raw advance
- **AND** the supervisor SHALL execute eligible recovery before returning a terminal result

#### Scenario: Successful one-item completion is observable

- **WHEN** the one-item controller resolves the issue
- **THEN** it SHALL emit `loop_run_complete` through the material event stream
- **AND** the host SHALL retain and wait for the controller process through that terminal event

#### Scenario: Numeric syntax uses the same one-item controller

- **WHEN** a host invokes mutating `pipeline <N>` for one issue
- **THEN** the CLI SHALL start or attach to the same durable one-item controller as `pipeline single <N>`
- **AND** nested whole-item advancement SHALL NOT mint a second supervisor
