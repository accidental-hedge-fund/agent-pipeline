## ADDED Requirements

### Requirement: Triage to ready SHALL request admission and SHALL NOT bypass the issue-readiness gate

`pipeline triage <N> --stage ready` SHALL remain a deterministic label write. It SHALL NOT invoke the issue-implementation-readiness gate, any other model harness, or a worktree create. When `issue_readiness.enabled` is `true`, that label write SHALL be an admission request only: the next pickup of issue N SHALL re-fetch the issue and SHALL require a `ready` verdict from the shared gate before any worktree or delivery harness starts.

#### Scenario: Triage still makes no model call

- **WHEN** the user runs `pipeline triage 42 --stage ready` while `issue_readiness.enabled` is `true`
- **THEN** the handler SHALL set `pipeline:ready` as specified by the existing triage requirements
- **AND** SHALL NOT invoke any model harness

#### Scenario: Next pickup still evaluates the fresh body

- **WHEN** triage has set `pipeline:ready` on an issue whose body is still thin
- **AND** a later pickup path runs with the gate enabled
- **THEN** that pickup SHALL run the shared gate
- **AND** SHALL NOT start a worktree or delivery harness unless the fresh body is admitted
