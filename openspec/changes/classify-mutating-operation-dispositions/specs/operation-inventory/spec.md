## Purpose

Defines the executable command-form disposition inventory that classifies every pipeline command form and routes lifecycle-affecting mutations through RecoverySupervisor.

## ADDED Requirements

### Requirement: The pipeline SHALL maintain an executable command-form inventory

The pipeline SHALL maintain one executable inventory of command forms. The inventory SHALL cover every `COMMAND_REGISTRY` keyword, the default numeric invocation, every nested subcommand the parser dispatches, and every documented mode form including `--dry-run`, `--apply`, and `status`. Each form SHALL declare an `execution_disposition` of `read-only`, `bounded-atomic-administration`, or `supervised-lifecycle`, and an independent `authority_requirement` of `none`, `typed-response`, or `protected-authority`. `OPERATION_SURFACE` SHALL remain the host and documentation catalog and SHALL NOT be treated as the complete inventory. The pipeline SHALL NOT add a public inventory CLI verb.

#### Scenario: Registry keyword has at least one form

- **WHEN** the inventory is loaded
- **THEN** every `COMMAND_REGISTRY` keyword SHALL have at least one form row
- **AND** the default numeric invocation SHALL be classified as the `advance` form

#### Scenario: Mode forms are independent rows

- **WHEN** a command documents `--dry-run`, `--apply`, or a `status` sub-verb
- **THEN** each of those forms SHALL have its own inventory row
- **AND** the dry-run form SHALL NOT inherit a supervised-lifecycle disposition from the apply or drive form

#### Scenario: OPERATION_SURFACE is not sufficient classification

- **WHEN** a verb appears only in `OPERATION_SURFACE` and has no inventory form
- **THEN** the inventory contract test SHALL fail
- **AND** adding the host-table row alone SHALL NOT classify the form

#### Scenario: Two axes are independent

- **WHEN** a form mutates GitHub and leaves no active run owner
- **THEN** it MAY be `bounded-atomic-administration` with `authority_requirement: none`
- **AND** `mutatesGitHub: true` SHALL NOT force `supervised-lifecycle`

---

### Requirement: A new mutating form without a disposition SHALL fail the contract suite

The test suite SHALL fail when a mutating command form has no inventory disposition. A mutating form is any form whose `execution_disposition` is not `read-only`, and any new `COMMAND_REGISTRY` keyword or documented mode form that performs a GitHub, git, worktree, run-store, pin, or recovery write. The failing test SHALL name the missing form id. The test SHALL run with injected seams and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Missing mutating keyword fails

- **WHEN** a new `COMMAND_REGISTRY` keyword that writes GitHub, git, worktree, run-store, pin, or recovery state is added without an inventory form
- **THEN** the contract test SHALL fail and name that keyword

#### Scenario: Missing apply form fails

- **WHEN** a documented `--apply` mode exists on a command and the inventory has only a dry-run or keyword row
- **THEN** the contract test SHALL fail and name the missing apply form

#### Scenario: Read-only addition without GitHub writes does not require supervised disposition

- **WHEN** a new documented read-only form is added with `execution_disposition: read-only` and `authority_requirement: none`
- **THEN** the missing-mutating-disposition test SHALL pass for that form

---

### Requirement: Supervised-lifecycle forms SHALL report observations to RecoverySupervisor

Every form with `execution_disposition: supervised-lifecycle` SHALL act as an operation adapter. It SHALL report a typed operation observation with side-effect certainty to RecoverySupervisor. It SHALL NOT declare terminal lifecycle for mechanical failure, retry exhaustion, timeout, or uncertain side effects. RecoverySupervisor SHALL remain the sole lifecycle owner. Parser usage errors MAY exit 2 before any mutation. A supervised form SHALL NOT silently terminate through raw `process.exit(1)` on a mechanical fault.

#### Scenario: Mechanical fault stays owned

- **WHEN** a supervised-lifecycle form hits an exception, nonzero subprocess exit, timeout, or uncertain side effect after admission
- **THEN** the form SHALL emit a typed operation observation
- **AND** it SHALL NOT mark the Logical Operation complete, cancelled, or human-owned
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Stale active admission cannot overwrite cooling

- **WHEN** a cooling observation is persisted for a Logical Operation
- **AND** a concurrent or delayed active admission is persisted for the same domain and logical_operation_id
- **THEN** the durable claim SHALL remain cooling
- **AND** the fault evidence SHALL remain available to RecoverySupervisor

#### Scenario: Supervised mechanical process.exit is forbidden

- **WHEN** a static or unit guard inspects a supervised-lifecycle command module
- **AND** that module calls `process.exit(1)` on a mechanical or recovery fault
- **THEN** the guard SHALL fail
- **AND** parser exit 2 before mutation SHALL remain allowed

#### Scenario: Usage error still exits 2

- **WHEN** an operator invokes a supervised form with an unsupported flag
- **THEN** the CLI SHALL exit 2 before config writes or GitHub mutation
- **AND** no recovery episode SHALL be created for that usage error

---

### Requirement: Bounded-atomic-administration forms SHALL leave no active run ownerless

A form with `execution_disposition: bounded-atomic-administration` SHALL finish in one bounded transaction. It SHALL leave no active Logical Operation ownership on success or failure. It SHALL be idempotent or fully reconcilable against the authoritative observer. Each such inventory row SHALL document why durable lifecycle ownership does not apply. A crash or failure fixture SHALL leave no active run ownerless.

#### Scenario: Failed bounded-atomic leaves no ownerless run

- **WHEN** a bounded-atomic-administration form fails or crashes mid-transaction
- **THEN** no active pipeline run SHALL be left without an owner
- **AND** a retry SHALL be idempotent or reconcilable from observer state

#### Scenario: Inventory documents the ownership exception

- **WHEN** a bounded-atomic-administration row is inspected
- **THEN** it SHALL include a written reason that durable lifecycle ownership does not apply
- **AND** a row missing that reason SHALL fail the contract test

#### Scenario: Starting nested drives is not bounded-atomic

- **WHEN** a form starts or drives a pipeline run
- **THEN** its execution disposition SHALL be `supervised-lifecycle`
- **AND** it SHALL NOT be classified as bounded-atomic-administration

---

### Requirement: Read-only forms SHALL NOT mutate recovery state

A form with `execution_disposition: read-only` SHALL NOT create, update, or cancel recovery episodes, claims, Cooling records, or typed requests. Documented dry-run and status forms SHALL be `read-only`. Standalone `pipeline doctor` SHALL be `read-only`.

#### Scenario: Status does not write recovery

- **WHEN** an operator runs `pipeline status N`
- **THEN** the command SHALL NOT create or modify a recovery episode, claim, Cooling record, or typed request

#### Scenario: Dry-run does not write recovery

- **WHEN** an operator runs a documented `--dry-run` form
- **THEN** the command SHALL perform no GitHub mutation
- **AND** SHALL NOT write recovery state

#### Scenario: Standalone doctor does not write recovery

- **WHEN** an operator runs `pipeline doctor` and checks fail
- **THEN** the process MAY exit 1
- **AND** the command SHALL NOT write a recovery episode or typed request

---

### Requirement: Registry, parser, generated docs, and executable behavior SHALL agree

The command-form inventory, `COMMAND_REGISTRY`, parser dispatch, generated `docs/cli.md`, and generated host SKILL tables SHALL agree on the classified forms. Parser dispatch keywords SHALL be a subset of inventory keywords. Every `OPERATION_SURFACE` verb SHALL have an inventory form. Generated usage text SHALL NOT advertise an `--apply` or drive mutation for a form classified `read-only`, and SHALL NOT omit a documented dry-run form classified `read-only`.

#### Scenario: Parser keyword missing from inventory fails

- **WHEN** the parser dispatches a keyword that has no inventory form
- **THEN** the agreement test SHALL fail and name the keyword

#### Scenario: Generated docs contradict dry-run classification

- **WHEN** a form is classified `read-only` as a dry-run
- **AND** generated `docs/cli.md` or a host SKILL table describes that invocation as mutating GitHub or starting a run
- **THEN** the agreement test SHALL fail

#### Scenario: Host catalog subset

- **WHEN** `OPERATION_SURFACE` lists a verb
- **THEN** the inventory SHALL contain a form for that verb
