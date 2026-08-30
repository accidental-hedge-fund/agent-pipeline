# triage-sub-command Specification

## Purpose
TBD - created by archiving change triage-sub-command. Update Purpose after archive.

## Requirements

### Requirement: The `triage` sub-command SHALL accept an issue number and a `--stage` flag

The pipeline CLI SHALL accept `triage` as a positional sub-command keyword. When the first positional argument is the string `triage` (case-sensitive), the CLI SHALL dispatch to the triage handler. The triage handler SHALL require a second positional argument that is a positive integer issue number and a `--stage <value>` flag. Omitting either SHALL cause the handler to exit non-zero with a usage error.

#### Scenario: Invoked with issue number and stage flag

- **WHEN** the user runs `pipeline triage 42 --stage ready`
- **THEN** the CLI dispatches the triage handler with issue number `42` and target stage `ready`
- **AND** SHALL NOT attempt to advance any pipeline stage via the advance loop

#### Scenario: Missing issue number exits with usage error

- **WHEN** the user runs `pipeline triage --stage ready` with no issue number
- **THEN** the command SHALL exit non-zero with a usage error indicating that an issue number is required

#### Scenario: Missing `--stage` flag exits with usage error

- **WHEN** the user runs `pipeline triage 42` with no `--stage` flag
- **THEN** the command SHALL exit non-zero with a usage error indicating that `--stage` is required

#### Scenario: Non-numeric issue argument exits with a clear error

- **WHEN** the user runs `pipeline triage abc --stage ready` where `abc` is not a positive integer
- **THEN** the command SHALL exit non-zero with an error message explaining that the issue argument must be a positive integer

---

### Requirement: The `triage` sub-command SHALL only accept pre-pipeline stages as the `--stage` value

The `triage` sub-command SHALL accept only `backlog` and `ready` as valid `--stage` values. Any other value — including any mid-flight stage name (`planning`, `plan-review`, `implementing`, `review-1`, `fix-1`, `review-2`, `fix-2`, `pre-merge`, `eval-gate`, `shipcheck-gate`, `ready-to-deploy`) — SHALL cause the handler to exit non-zero with a clear error naming the rejected value and listing the allowed values. No GitHub API call SHALL be made when the stage value is invalid.

#### Scenario: `--stage ready` is accepted

- **WHEN** the user runs `pipeline triage 42 --stage ready`
- **THEN** the handler accepts the stage value and proceeds to read the issue's current labels

#### Scenario: `--stage backlog` is accepted

- **WHEN** the user runs `pipeline triage 42 --stage backlog`
- **THEN** the handler accepts the stage value and proceeds to read the issue's current labels

#### Scenario: Mid-flight stage is rejected before any GitHub call

- **WHEN** the user runs `pipeline triage 42 --stage planning`
- **THEN** the command SHALL exit non-zero with an error message naming `planning` as invalid and listing `backlog` and `ready` as the allowed values
- **AND** no GitHub API call SHALL have been made

#### Scenario: Terminal stage is rejected

- **WHEN** the user runs `pipeline triage 42 --stage ready-to-deploy`
- **THEN** the command SHALL exit non-zero with an error message naming `ready-to-deploy` as invalid
- **AND** no GitHub API call SHALL have been made

---

### Requirement: The `triage` sub-command SHALL set exactly one `pipeline:<stage>` label on the target issue

After validating inputs, the triage handler SHALL fetch the target issue. For `--stage backlog`, it SHALL determine which `pipeline:*` labels the issue currently carries and update the issue so it carries exactly `pipeline:backlog` and no other `pipeline:*` label, with no Decisions-artifact requirement. For `--stage ready`, it SHALL validate the Decisions artifact as specified by `grill-then-ready-refinement` before any label write; on validation failure it SHALL exit 2 and SHALL NOT add or remove labels. On validation success it SHALL add `pipeline:ready` first (if not already present), then remove all current `pipeline:*` labels that differ from `ready`, then re-fetch labels. If more than one `pipeline:*` label remains, it SHALL retry the remove pass once. If extras still remain, it SHALL exit non-zero with `label_reconciliation_failed` and SHALL NOT remove `pipeline:ready`. This ordering ensures the issue is never left without a `pipeline:*` label if the process is interrupted between writes. Validation failure SHALL still make zero label-write API calls.

#### Scenario: Sets `pipeline:ready` and removes `pipeline:backlog`

- **WHEN** the issue carries `pipeline:backlog`
- **AND** the Decisions artifact is complete, provenanced, and fingerprint-current
- **AND** the user runs `pipeline triage <N> --stage ready`
- **THEN** the handler SHALL remove `pipeline:backlog` from the issue
- **AND** SHALL add `pipeline:ready` to the issue
- **AND** the issue SHALL carry exactly `pipeline:ready` among its `pipeline:*` labels

#### Scenario: Incomplete Decisions artifact refuses ready without label writes

- **WHEN** the issue carries `pipeline:backlog`
- **AND** the Decisions artifact is missing, incomplete, or stale
- **AND** the user runs `pipeline triage <N> --stage ready`
- **THEN** the command SHALL exit 2
- **AND** SHALL NOT call any GitHub label-write API
- **AND** the issue SHALL still carry `pipeline:backlog`

#### Scenario: Sets `pipeline:backlog` and removes `pipeline:ready`

- **WHEN** the issue carries `pipeline:ready` and the user runs `pipeline triage <N> --stage backlog`
- **THEN** the handler SHALL remove `pipeline:ready` from the issue
- **AND** SHALL add `pipeline:backlog` to the issue

#### Scenario: Removes a mid-flight label when resetting to pre-pipeline

- **WHEN** the issue carries `pipeline:planning` (a mid-flight label) and the user runs `pipeline triage <N> --stage backlog`
- **THEN** the handler SHALL remove `pipeline:planning` from the issue
- **AND** SHALL add `pipeline:backlog` to the issue

#### Scenario: Handles multiple existing `pipeline:*` labels

- **WHEN** the issue carries both `pipeline:ready` and `pipeline:planning` (a corrupted label state) and the user runs `pipeline triage <N> --stage backlog`
- **THEN** the handler SHALL remove both `pipeline:ready` and `pipeline:planning`
- **AND** SHALL add `pipeline:backlog`
- **AND** the issue SHALL carry exactly one `pipeline:*` label after the operation

#### Scenario: Ready write retries a partial remove failure

- **WHEN** the Decisions artifact is complete, provenanced, and fingerprint-current
- **AND** add `pipeline:ready` succeeds
- **AND** the first remove of `pipeline:backlog` fails
- **AND** the retry remove succeeds
- **THEN** the issue SHALL carry exactly `pipeline:ready` among its `pipeline:*` labels
- **AND** the command SHALL exit 0

#### Scenario: Persistent extra labels fail closed without dropping ready

- **WHEN** the Decisions artifact is complete, provenanced, and fingerprint-current
- **AND** add `pipeline:ready` succeeds
- **AND** remove of the previous stage label fails twice
- **THEN** the command SHALL exit non-zero
- **AND** the issue SHALL still carry `pipeline:ready`
- **AND** validation-failure paths SHALL still make zero label-write calls

---

### Requirement: The `triage` sub-command SHALL be idempotent

When the target issue already carries exactly the requested `pipeline:<stage>` label and no other `pipeline:*` label, the handler SHALL exit 0 without making any GitHub write API call if the request is `--stage backlog`, or if the request is `--stage ready` and the Decisions artifact is complete, provenanced, and fingerprint-current. A `--stage ready` request on an issue that already carries `pipeline:ready` SHALL still re-fetch and validate the Decisions artifact; incomplete or stale artifacts SHALL exit 2 with no label change. It SHALL log a message indicating the label is already set only when validation passes.

#### Scenario: Already set — no GitHub write

- **WHEN** the issue already carries `pipeline:ready` and no other `pipeline:*` label
- **AND** the Decisions artifact is complete, provenanced, and fingerprint-current
- **AND** the user runs `pipeline triage <N> --stage ready`
- **THEN** the command SHALL exit 0
- **AND** SHALL NOT call any GitHub label-write API (no `addLabel`, no `removeLabel`)
- **AND** SHALL log a message indicating the stage is already set to `ready`

#### Scenario: Already ready with a stale artifact still exits 2

- **WHEN** the issue already carries `pipeline:ready` and no other `pipeline:*` label
- **AND** the Decisions artifact is missing, incomplete, or stale
- **AND** the user runs `pipeline triage <N> --stage ready`
- **THEN** the command SHALL exit 2
- **AND** SHALL NOT add or remove labels
- **AND** the issue SHALL still carry `pipeline:ready`

### Requirement: The `triage` sub-command SHALL make no model harness call

The triage handler SHALL be fully deterministic. It SHALL NOT invoke any AI model harness, prompt template, or LLM API. All behavior SHALL be determined by the issue number, the `--stage` flag value, and the GitHub API response for the issue's current labels.

#### Scenario: No harness call on any code path

- **WHEN** `pipeline triage <N> --stage ready` runs to completion (including success and all error paths)
- **THEN** no model harness invocation SHALL occur

---

### Requirement: The `triage` sub-command SHALL use an injectable deps seam for all external I/O

All GitHub API calls and log output in the triage handler SHALL be routed through a `TriageDeps` interface. The production implementation (`realTriageDeps()`) wires each member to the real `gh` wrappers. Unit tests supply fake implementations. No unit test SHALL perform any real network, git, or subprocess call.

#### Scenario: Unit tests use fake deps

- **WHEN** `runTriage` is called in a unit test with a fake `TriageDeps` implementation
- **THEN** no real GitHub API call, git command, or subprocess is executed
- **AND** the fake's recorded calls can be inspected to verify correct behavior

### Requirement: Triage to ready SHALL request admission and SHALL NOT bypass the issue-readiness gate

`pipeline triage <N> --stage ready` SHALL remain a deterministic command. It SHALL NOT invoke the issue-implementation-readiness gate, any other model harness, or a worktree create. It SHALL validate the Decisions artifact as specified by `grill-then-ready-refinement` before any ready label write. When that validation passes and `issue_readiness.enabled` is `true`, the label write SHALL be an admission request only: the next pickup of issue N SHALL re-fetch the issue and SHALL require a `ready` verdict from the shared #1238 gate before any worktree or delivery harness starts.

#### Scenario: Triage still makes no model call

- **WHEN** the user runs `pipeline triage 42 --stage ready` while `issue_readiness.enabled` is `true`
- **AND** the Decisions artifact is complete, provenanced, and fingerprint-current
- **THEN** the handler SHALL set `pipeline:ready` as specified by the existing triage requirements
- **AND** SHALL NOT invoke any model harness

#### Scenario: Incomplete artifact is not an admission request

- **WHEN** the user runs `pipeline triage 42 --stage ready`
- **AND** the Decisions artifact is incomplete or stale
- **THEN** the handler SHALL exit 2
- **AND** SHALL NOT set `pipeline:ready`
- **AND** SHALL NOT invoke any model harness

#### Scenario: Next pickup still evaluates the fresh body

- **WHEN** triage has set `pipeline:ready`
- **AND** a later pickup path runs with the gate enabled
- **THEN** that pickup SHALL run the shared gate
- **AND** SHALL NOT start a worktree or delivery harness unless the fresh body is admitted

---
