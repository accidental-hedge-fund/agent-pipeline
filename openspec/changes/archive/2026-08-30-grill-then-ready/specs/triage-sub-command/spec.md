## MODIFIED Requirements

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
