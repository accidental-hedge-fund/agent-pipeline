# correction-record-command Specification

## Purpose
TBD - created by archiving change correction-event-ledger. Update Purpose after archive.
## Requirements
### Requirement: A pipeline correction record command SHALL record a manual correction against an existing run

The pipeline CLI SHALL provide a `correction record` command that appends exactly one
`correction_event` (with `actor_kind: "human"`) against an existing run. The command SHALL
require explicit fields and SHALL NOT infer them: the corrective `source_kind`, the
`failure_class`, the `stage`, a reference locating the target run (the issue number and either
an explicit run id or the resolved latest run for that issue), the `evidence_ref`, the
`correction` disposition text, and the `reusable` value; `proposed_control` SHALL be optional.
When every required field is supplied and the target run is located, the command SHALL append
one sanitized `correction_event` and exit zero. When a required field is missing or the target
run cannot be located, the command SHALL append no event and exit non-zero with an error.

#### Scenario: complete invocation records one correction

- **WHEN** `correction record` is invoked with all required fields and the target run exists
- **THEN** exactly one `correction_event` SHALL be appended to that run's event stream with `actor_kind: "human"`
- **AND** the command SHALL exit zero

#### Scenario: missing required field records nothing

- **WHEN** `correction record` is invoked without a required field (e.g. `--source-kind`, `--failure-class`, `--stage`, `--evidence-ref`, `--correction`, or `--reusable`)
- **THEN** the command SHALL append no `correction_event`
- **AND** it SHALL exit non-zero with an error naming the missing field

#### Scenario: unlocatable run records nothing

- **WHEN** `correction record` is invoked but the referenced run cannot be located
- **THEN** the command SHALL append no `correction_event`
- **AND** it SHALL exit non-zero with an error

### Requirement: The correction record command SHALL only accept operator-driven source kinds

Because `correction record` always emits `actor_kind: "human"`, its `--source-kind` SHALL be
restricted to the operator-driven source kinds (`override`, `rejection`, `unblock`, `manual`).
The autonomous-recovery source kinds `retry` and `repair` SHALL be rejected, since accepting
them would let a human-invoked command produce a record that misattributes an operator action
as an autonomous pipeline recovery or repair.

#### Scenario: retry/repair are rejected

- **WHEN** `correction record` is invoked with `--source-kind retry` or `--source-kind repair`
- **THEN** the command SHALL append no `correction_event`
- **AND** it SHALL exit non-zero with an error naming `--source-kind`

### Requirement: The correction record command SHALL have no advance, unblock, override, merge, deploy, or code-mutation authority

The `correction record` command SHALL be strictly evidence-recording: its only side effect
SHALL be appending one `correction_event` (via the shared append path plus any configured event
sink). It SHALL NOT advance the pipeline, unblock an issue, apply an override, merge, deploy,
publish, or mutate any code, branch, worktree, or GitHub issue/PR state. Its command-registry
entry SHALL declare `mutatesGitHub: false`, and the CLI SHALL reject any flag the command does
not declare via the existing allowlist-based flag validation before any side effect.

#### Scenario: command mutates no GitHub or code state

- **WHEN** `correction record` runs to completion
- **THEN** it SHALL NOT change any label, branch, worktree, commit, PR, or issue state
- **AND** its only durable effect SHALL be the appended `correction_event`

#### Scenario: registry entry declares the command non-mutating

- **WHEN** the `correction` command's `COMMAND_REGISTRY` entry is inspected
- **THEN** it SHALL declare `mutatesGitHub: false`

#### Scenario: undeclared flag is rejected before any side effect

- **WHEN** `correction record` is invoked with a flag it does not declare in its `allowedFlags`
- **THEN** the CLI SHALL exit with code 2 naming the offending flag
- **AND** no `correction_event` SHALL be appended

