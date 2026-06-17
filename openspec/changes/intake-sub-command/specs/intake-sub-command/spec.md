## ADDED Requirements

### Requirement: The `intake` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `intake` as a positional sub-command keyword that requires no issue number and that does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `intake` (case-sensitive). A `--description "<text>"` flag or a second positional string SHALL supply the free-text seed description; omitting both SHALL exit non-zero with a usage error.

#### Scenario: Invoked with a description flag

- **WHEN** the user runs `pipeline intake --description "add retry logic to the fix loop"`
- **THEN** the command dispatches the intake handler, does not read or write any pipeline stage label, and proceeds to spec generation

#### Scenario: Invoked with a positional description

- **WHEN** the user runs `pipeline intake "add retry logic to the fix loop"`
- **THEN** the command dispatches the intake handler identically to the `--description` form

#### Scenario: Invoked with no description

- **WHEN** the user runs `pipeline intake` with no description argument or flag
- **THEN** the command SHALL exit non-zero with a usage error explaining that a description is required

#### Scenario: Numeric positional is rejected as ambiguous

- **WHEN** the user runs `pipeline intake 42` where `42` is a digit-only string
- **THEN** the command SHALL exit non-zero with an error message explaining that `intake` requires a description string, not an issue number

---

### Requirement: The `intake` sub-command SHALL produce a structured spec via a single model harness call

Given a short free-text description, the handler SHALL invoke exactly one model harness call that expands the description into a structured spec following the WHAT-not-HOW / observable-AC contract: a **Summary** (one paragraph), a **User story** (`As a … / I want … / so that …`), **Acceptance criteria** (checkable `- [ ]` items stating observable, falsifiable behaviors), **Out of scope** (explicit exclusions), and **Open questions** only when the description is genuinely ambiguous. The acceptance criteria SHALL be testable behaviors, not approach descriptions.

#### Scenario: Well-specified description produces a complete spec

- **WHEN** the handler receives a description that names a concrete, bounded feature
- **THEN** the generated spec SHALL contain Summary, User story, Acceptance criteria, and Out of scope sections
- **AND** each acceptance criterion SHALL be a testable, observable outcome (not an approach step)
- **AND** the Open questions section SHALL be absent or empty

#### Scenario: Ambiguous description surfaces open questions

- **WHEN** the handler receives a description that omits a decision the implementation requires (e.g., "add a cache" without specifying scope or invalidation)
- **THEN** the generated spec SHALL include a non-empty Open questions section listing the unresolved decision(s)

#### Scenario: Spec generation is the only model-invoking step

- **WHEN** the intake handler runs to completion (creating an issue and roadmap PR)
- **THEN** exactly one model harness call was made (for spec generation); all subsequent steps (issue creation, roadmap editing, PR creation) are deterministic given the spec

---

### Requirement: The `intake` sub-command SHALL create a GitHub issue from the generated spec

After spec generation, the handler SHALL call the GitHub API to create an issue in the target repo. The issue body SHALL be the full generated spec text. The issue SHALL receive at minimum two labels: one `pipeline:ready` triage label and one `release:vX.Y.Z` label whose value is either the `--release` argument or the proposed release slot.

#### Scenario: Issue created with correct labels

- **WHEN** intake runs successfully with `--release v1.7.0`
- **THEN** a GitHub issue is created with the generated spec as its body
- **AND** the issue carries both the `pipeline:ready` label and the `release:v1.7.0` label

#### Scenario: Proposed release slot when `--release` is omitted

- **WHEN** the user runs `pipeline intake --description "..."` without `--release`
- **THEN** the handler proposes a release slot derived from the roadmap context (e.g., the next open minor version lane)
- **AND** the issue is created with a `release:vX.Y.Z` label matching the proposed slot

---

### Requirement: The `intake` sub-command SHALL propose a ROADMAP.md update as a branch and PR

After issue creation, the handler SHALL write three consistent mutations to `ROADMAP.md` — (1) a release-plan table row, (2) a per-issue sem-ver table row, (3) a detail-section bullet under the target release section — commit them on a new branch, and open a PR targeting the default branch. The handler SHALL NOT commit directly to the default branch. The PR body SHALL summarize the new issue and proposed release slot.

#### Scenario: ROADMAP PR opened for human review

- **WHEN** intake runs successfully
- **THEN** a new branch is created with the roadmap edits
- **AND** a PR is opened targeting the default branch
- **AND** no commit is made directly to the default or main branch

#### Scenario: All three ROADMAP structures updated consistently

- **WHEN** the roadmap PR is created
- **THEN** `ROADMAP.md` contains a new release-plan table row for the issue
- **AND** a new per-issue sem-ver table row for the issue
- **AND** a new detail-section bullet in the correct release version section
- **AND** all three reference the same issue number and release version

#### Scenario: `--release` pins the target slot

- **WHEN** the user supplies `--release v1.7.0`
- **THEN** all three ROADMAP mutations reference `v1.7.0`
- **AND** the `release:v1.7.0` label is applied to the created issue

---

### Requirement: The `intake` sub-command SHALL support a `--dry-run` mode that writes nothing

Under `--dry-run`, the handler SHALL print the proposed spec and the roadmap diff to stdout and exit without creating a GitHub issue, writing any file, creating a branch, or opening a PR.

#### Scenario: Dry-run prints proposed spec and diff

- **WHEN** the user runs `pipeline intake --description "..." --dry-run`
- **THEN** the proposed issue body is printed to stdout
- **AND** the proposed ROADMAP.md diff is printed to stdout
- **AND** no GitHub issue is created
- **AND** no branch is created and no PR is opened

#### Scenario: Dry-run is compatible with `--release`

- **WHEN** the user runs `pipeline intake --description "..." --dry-run --release v1.7.0`
- **THEN** the dry-run output uses `v1.7.0` as the target release
- **AND** no writes occur

---

### Requirement: The `intake` handler SHALL use injectable I/O deps for all external calls

All external calls (model harness, GitHub issue creation, file reads/writes, git branch/PR creation) SHALL be injected via a `IntakeDeps` interface so unit tests can substitute fakes. No real network, git, or subprocess calls SHALL occur in unit tests.

#### Scenario: Unit tests exercise all branches via fakes

- **WHEN** intake tests run using a fake `IntakeDeps`
- **THEN** no real `gh` CLI, harness, or filesystem call is made
- **AND** the tests cover the dry-run path, issue-creation path, roadmap-PR path, and error paths (missing description, anchor-not-found)
