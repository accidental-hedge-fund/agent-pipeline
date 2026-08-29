## RENAMED Requirements

- FROM: ### Requirement: Host SKILL guidance for `pipeline loop` SHALL NOT claim multi-item runs complete in seconds without progress follow
- TO: ### Requirement: Operator guidance for `pipeline loop` SHALL NOT claim multi-item runs complete in seconds without progress follow
- FROM: ### Requirement: Host SKILL guidance for `pipeline loop` SHALL describe durable runs as long-running and event-followed
- TO: ### Requirement: Operator guidance for `pipeline loop` SHALL describe durable runs as long-running and event-followed

## MODIFIED Requirements

### Requirement: `pipeline loop` SHALL be the canonical durable multi-item run command on every host

The CLI SHALL expose a `loop` operation as `pipeline loop`. Each generated host
one-pager SHALL expose one compact `pipeline loop` row sourced from
`OPERATION_SURFACE`, execute that CLI directly, and link to the generated
`docs/cli.md` reference for the complete argument contract. The CLI and durable
reference SHALL accept exactly these selector and mode arguments:
`--milestone <name>`, `--label <label>`, `--range <spec>`,
`--roadmap-slice <slice>`, an explicit issue list (one or more issue numbers),
`--resume <run-id>`, and `--audit`. Selector arguments SHALL be mutually
exclusive with `--resume`, and `--audit` SHALL be read-only. The generated
one-pager SHALL NOT be required to copy the full selector essay or depend on a
generated `/pipeline:loop` or `$pipeline:loop` file.

#### Scenario: Host SKILLs expose the same CLI loop contract

- **WHEN** the CLI registry and generated host one-pager verb tables are enumerated
- **THEN** each one-pager SHALL describe exactly one `pipeline loop` operation
- **AND** each SHALL link to the same complete CLI argument reference
- **AND** no per-verb command file SHALL be required

#### Scenario: Each selector form parses to a normalized selector

- **WHEN** `pipeline loop` is invoked with `--milestone v2`, `--label backlog`,
  `--range 400-420`, `--roadmap-slice next`, or an explicit list `418 419 420`
- **THEN** argument normalization SHALL produce a selector whose type is respectively
  `milestone`, `label`, `work-list`, `roadmap-slice`, and `work-list`, with the
  corresponding value
- **AND** an invocation combining a selector with `--resume` SHALL be rejected with a
  non-zero exit and a message naming the conflict

#### Scenario: Audit mode is read-only

- **WHEN** `pipeline loop --audit` is invoked for an existing run
- **THEN** it SHALL print that run's status/report from the durable store
- **AND** it SHALL perform no write to the ledger, no lock acquisition, and no GitHub
  mutation

---

### Requirement: Operator guidance for `pipeline loop` SHALL NOT claim multi-item runs complete in seconds without progress follow

Durable operator documentation for `pipeline loop` SHALL describe multi-item
drive and resume as long-running and event-followed. The generated one-pager's
compact shared contract SHALL name `run_id`, the event-follow command, reattach,
and terminal stop; it SHALL NOT carry the retired long-form Monitor or discovery
essay. Neither surface SHALL claim that durable drive completes in seconds or
needs no progress follow. Read-only `--audit` MAY still be described as fast in
`docs/cli.md`. No generated per-verb command file SHALL carry this guidance.

#### Scenario: Host SKILL no longer denies progress follow for multi-item drive

- **WHEN** any generated host one-pager is inspected
- **THEN** it SHALL NOT claim that multi-item durable drive completes in seconds
  with no progress follow
- **AND** its compact contract SHALL name `run_id` and event following

#### Scenario: Both hosts stay aligned

- **WHEN** an operator reads the `pipeline loop` section in `docs/cli.md` or its
  linked durable orchestration documentation
- **THEN** the docs SHALL describe drive and resume as long-running
- **AND** they SHALL describe the handoff and event-follow path without requiring
  a generated `/pipeline:loop` or `$pipeline:loop` file

### Requirement: Operator guidance for `pipeline loop` SHALL describe durable runs as long-running and event-followed

The CLI reference and durable orchestration documentation SHALL describe
multi-item drive and resume as long-running work followed through the loop event
stream. The generated one-pager SHALL preserve only the compact, host-neutral
follow-until-terminal contract and links to those docs. It SHALL NOT reproduce
host-specific Monitor procedures, state-home discovery, or dual-follow shell
scripts. This packaging rule SHALL NOT change preflight order, contract
compilation, execution through `pipeline/loop-execution@1`, or the facade's
refusal to merge.

#### Scenario: Drive packaging points at event following

- **WHEN** a harness or operator reads the durable `pipeline loop` guidance
- **THEN** the guidance SHALL describe event following for drive and resume
- **AND** it SHALL NOT describe those mutating modes as seconds-only synchronous
  commands

#### Scenario: Compact host contract stays aligned

- **WHEN** the four generated host one-pagers are compared
- **THEN** each SHALL carry the same compact follow-until-terminal contract
- **AND** none SHALL carry a host-specific long-form loop essay

#### Scenario: Facade execution rules remain unchanged

- **WHEN** this packaging requirement is applied
- **THEN** selected items SHALL still execute through the unmodified Pipeline
  state machine and evidence gates
- **AND** the facade SHALL still perform no merge
