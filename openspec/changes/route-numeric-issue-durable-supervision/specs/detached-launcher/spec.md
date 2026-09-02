## ADDED Requirements

### Requirement: Detached numeric launch SHALL detach the one-item durable supervisor

`pipeline <N> --detach` and its `pipeline run <N> --detach` alias SHALL detach the same one-item durable supervisor used by `pipeline single <N>`. The detached child SHALL NOT use raw stage advancement as its top-level lifecycle owner. Existing detach safety (repo resolution before artifacts, issue-run lock, sentinel, timeout watchdog, and rejection of mode-selector flags) SHALL still apply. Stage-specific compatibility flags that remain valid with `--detach` SHALL be forwarded as immutable child inputs to nested advancement.

#### Scenario: Detach launches the one-item supervisor

- **WHEN** `pipeline <N> --detach` is invoked from a resolvable git checkout
- **THEN** the detached child SHALL be the one-item durable supervisor
- **AND** it SHALL NOT detach a raw-advance owner

#### Scenario: Run alias detaches the same supervisor

- **WHEN** `pipeline run <N> --detach` is invoked from a resolvable git checkout
- **THEN** the detached child SHALL match the `pipeline <N> --detach` supervisor lifecycle
- **AND** it SHALL still honor the existing repo-resolution, lock, and sentinel contract
