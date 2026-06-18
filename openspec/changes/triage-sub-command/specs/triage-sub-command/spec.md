## ADDED Requirements

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

After validating inputs, the triage handler SHALL fetch the target issue's current labels, determine which `pipeline:*` labels it currently carries, and update the issue so it carries exactly the target `pipeline:<stage>` label and no other `pipeline:*` label. The handler SHALL remove all current `pipeline:*` labels that differ from the target, then add the target label if not already present.

#### Scenario: Sets `pipeline:ready` and removes `pipeline:backlog`

- **WHEN** the issue carries `pipeline:backlog` and the user runs `pipeline triage <N> --stage ready`
- **THEN** the handler SHALL remove `pipeline:backlog` from the issue
- **AND** SHALL add `pipeline:ready` to the issue
- **AND** the issue SHALL carry exactly `pipeline:ready` among its `pipeline:*` labels

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

---

### Requirement: The `triage` sub-command SHALL be idempotent

When the target issue already carries exactly the requested `pipeline:<stage>` label and no other `pipeline:*` label, the handler SHALL exit 0 without making any GitHub write API call. It SHALL log a message indicating the label is already set.

#### Scenario: Already set — no GitHub write

- **WHEN** the issue already carries `pipeline:ready` and no other `pipeline:*` label, and the user runs `pipeline triage <N> --stage ready`
- **THEN** the command SHALL exit 0
- **AND** SHALL NOT call any GitHub label-write API (no `addLabel`, no `removeLabel`)
- **AND** SHALL log a message indicating the stage is already set to `ready`

---

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
