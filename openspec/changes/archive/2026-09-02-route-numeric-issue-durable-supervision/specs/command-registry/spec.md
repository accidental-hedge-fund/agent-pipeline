## ADDED Requirements

### Requirement: Mutating numeric invocation SHALL alias to the one-item durable supervisor after mode preservation

After flag validation, the CLI SHALL preserve read-only and mode-selector forms on a numeric first argument, then alias remaining mutating numeric drive to the canonical one-item durable supervisor used by `pipeline single`. Hidden `pipeline run <N>` without `--detach` SHALL follow that same mutating numeric alias. The `advance` registry entry MAY continue to accept compatibility flags (`allowedFlags: "all"`) so stage-specific inputs parse. Those flags SHALL become immutable child inputs. They SHALL NOT keep raw stage advancement as the public lifecycle owner. `--detach` on numeric drive or the hidden `run` alias SHALL detach the same one-item supervisor.

#### Scenario: Mutating numeric aliases after status is preserved

- **WHEN** the operator invokes `pipeline 42`
- **THEN** the CLI SHALL enter the one-item durable supervisor used by `pipeline single 42`
- **AND** `pipeline 42 --status` SHALL still dispatch status and SHALL NOT enter that supervisor

#### Scenario: Hidden run alias follows the same mutating path

- **WHEN** the operator invokes `pipeline run 42` without `--detach`
- **THEN** the CLI SHALL alias to the same one-item durable supervisor as mutating `pipeline 42`
- **AND** it SHALL NOT call raw stage advancement as the top-level owner

#### Scenario: Compatibility flags do not restore a raw-advance owner

- **WHEN** the operator invokes `pipeline 42 --once` or `pipeline 42 --dry-run`
- **THEN** flag validation SHALL still accept the flag on the numeric path
- **AND** the CLI SHALL still enter the one-item durable supervisor
- **AND** the flag SHALL be forwarded as a child input to nested advancement
