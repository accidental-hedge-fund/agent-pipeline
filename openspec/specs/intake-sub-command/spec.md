# intake-sub-command Specification

## Purpose
TBD - created by archiving change intake-sweep-configurable-timeout. Update Purpose after archive.
## Requirements
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

### Requirement: The `intake` sub-command SHALL create a GitHub issue from the generated spec

The handler SHALL call the GitHub API to create an issue in the target repo as the FIRST irreversible action — only after every reversible prerequisite has succeeded: spec generation, spec validation, ROADMAP anchor pre-validation, the clean-working-tree check, and preparation AND atomic reservation of the release branch. Branch preparation SHALL (1) derive a collision-resistant branch name that two concurrent runs with the same generated title and base SHA cannot share (e.g. by including a random token), and (2) RESERVE the remote ref create-only BEFORE the issue is created. The reservation SHALL satisfy three properties: (a) it SHALL fail when the ref already exists at ANY SHA — including the same base SHA (a plain push no-ops "up-to-date") and an ancestor SHA (a plain push would fast-forward and MOVE the existing ref) — and it SHALL NOT modify an existing ref; (b) it SHALL exercise the SAME push transport and credentials used to publish the roadmap commit afterwards, so a missing or read-only push credential fails during reservation (before the issue) rather than after it; and (c) on collision or failure it SHALL abort before issue creation. The reference implementation uses `git push` with an empty `--force-with-lease` (expect the ref absent) and treats only a newly-created ref status (`*`) as success. A failure in any preparatory step SHALL abort before issue creation so a labeled issue is never stranded without its roadmap PR. The post-issue push of the roadmap commit is then a fast-forward onto the already-reserved ref over the just-proven credential. The issue body SHALL be the full generated spec text. The issue SHALL receive at minimum two labels: one `pipeline:ready` triage label and one `release:vX.Y.Z` label whose value is either the `--release` argument or the proposed release slot.

The handler SHALL ensure both required labels exist before issue creation in a CREATE-ONLY manner: it SHALL create a label that is absent but SHALL NOT modify (clobber) the color or description of a label that already exists. An "already exists" result from the create call SHALL be treated as success.

#### Scenario: Issue created with correct labels

- **WHEN** intake runs successfully with `--release v1.7.0`
- **THEN** a GitHub issue is created with the generated spec as its body
- **AND** the issue carries both the `pipeline:ready` label and the `release:v1.7.0` label

#### Scenario: Proposed release slot when `--release` is omitted

- **WHEN** the user runs `pipeline intake --description "..."` without `--release`
- **THEN** the handler proposes a release slot derived from the roadmap context (e.g., the next open minor version lane)
- **AND** the issue is created with a `release:vX.Y.Z` label matching the proposed slot

#### Scenario: Branch-preparation failure never strands a labeled issue

- **WHEN** the release branch cannot be prepared (e.g., the base SHA is unresolvable, the branch name collides locally, or the working tree is dirty)
- **THEN** the command SHALL abort with a non-zero exit and SHALL NOT create any GitHub issue or open any PR

#### Scenario: A pre-existing remote branch aborts before issue creation

- **WHEN** a branch with the chosen head name already exists on `origin` (e.g., a prior intake run reserved it), even at the same base SHA
- **THEN** the atomic create-only reservation SHALL fail and the command SHALL abort with a non-zero exit BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Reservation failure aborts before issue creation

- **WHEN** the pre-issue atomic reservation of `origin/<branch>` fails (a colliding ref, or missing push/API capability)
- **THEN** the command SHALL abort with a non-zero exit BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Reservation is create-only, not a no-op push

- **WHEN** `origin/<branch>` already exists and points at the same base SHA the reservation would use
- **THEN** the reservation SHALL still be treated as a collision and abort before issue creation (it SHALL NOT succeed as a no-op "up-to-date" push that would let two runs both create issues)

#### Scenario: Reservation never moves an existing branch

- **WHEN** `origin/<branch>` already exists at an ANCESTOR of the reservation SHA
- **THEN** the reservation SHALL fail and abort before issue creation WITHOUT fast-forwarding (moving) the existing ref, so a prior intake or human branch is never advanced or corrupted

#### Scenario: A read-only or missing push credential aborts before issue creation

- **WHEN** the checkout's `origin` push credential is missing or read-only
- **THEN** the reservation (which uses the same push transport as the roadmap publish) SHALL fail and the command SHALL abort BEFORE creating the issue
- **AND** no GitHub issue is created and no PR is opened

#### Scenario: Concurrent identical specs cannot share a branch

- **WHEN** two intake runs generate the same title against the same base SHA at the same time
- **THEN** the collision-resistant branch names SHALL differ, so neither run's reservation push collides with the other and neither strands an issue

#### Scenario: Existing label metadata is not clobbered

- **WHEN** intake ensures `pipeline:ready` or `release:vX.Y.Z` and that label already exists with a curated color/description
- **THEN** the handler SHALL treat the label as present and SHALL NOT change its color or description (no `--force`)

### Requirement: The `intake` sub-command SHALL propose a ROADMAP.md update as a branch and PR

The handler SHALL resolve the base branch to an immutable commit SHA once, read `ROADMAP.md` at that pinned SHA, and prepare the release branch by forking from the SAME pinned SHA — so the content the mutation is computed against and the branch the mutation is written onto are one commit. Because `origin/<base>` is a moving ref, reading at the ref and separately branching from the ref could straddle a concurrent push and yield a PR that rolls back roadmap entries that landed in between; pinning to one SHA SHALL prevent this. The handler SHALL write three consistent mutations to `ROADMAP.md` — (1) a release-plan table row, (2) a per-issue sem-ver table row, (3) a detail-section bullet under the target release section — commit them on the prepared branch, and open a PR targeting the default branch. The handler SHALL NOT commit directly to the default branch. The PR body SHALL summarize the new issue and proposed release slot.

#### Scenario: ROADMAP PR opened for human review

- **WHEN** intake runs successfully
- **THEN** a new branch is created with the roadmap edits
- **AND** a PR is opened targeting the default branch
- **AND** no commit is made directly to the default or main branch

#### Scenario: Read and branch share one pinned base SHA

- **WHEN** intake prepares the roadmap PR
- **THEN** the same immutable base SHA is used both to read `ROADMAP.md` and to fork the release branch
- **AND** a concurrent push to `origin/<base>` between the read and the branch creation does not cause the PR to remove roadmap entries that landed on the base after the read

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

### Requirement: The `intake` handler SHALL use injectable I/O deps for all external calls

All external calls (model harness, GitHub issue creation, file reads/writes, git branch/PR creation) SHALL be injected via a `IntakeDeps` interface so unit tests can substitute fakes. No real network, git, or subprocess calls SHALL occur in unit tests.

#### Scenario: Unit tests exercise all branches via fakes

- **WHEN** intake tests run using a fake `IntakeDeps`
- **THEN** no real `gh` CLI, harness, or filesystem call is made
- **AND** the tests cover the dry-run path, issue-creation path, roadmap-PR path, and error paths (missing description, anchor-not-found)

### Requirement: The intake harness call SHALL be bounded by `cfg.intake_timeout`

The `IntakeDeps.runHarness` interface SHALL accept a `timeoutSec: number` parameter.
The real dep implementation (`realIntakeDeps`) SHALL pass this value as `timeoutSec`
to `invoke()`, overriding the implicit 1200 s default. The `runIntake()` handler SHALL
supply `cfg.intake_timeout` as the `timeoutSec` argument on every call to
`d.runHarness`. A hung or unresponsive endpoint SHALL therefore be killed after
`cfg.intake_timeout` seconds — not after the 20-minute `invoke()` default — and the
sub-command SHALL exit non-zero with an error surfacing the timeout.

#### Scenario: Harness call respects the configured timeout

- **WHEN** `cfg.intake_timeout` is 300 and the intake handler invokes `d.runHarness`
- **THEN** the `timeoutSec` argument passed to the underlying `invoke()` call SHALL be 300
- **AND** an endpoint that does not respond within 300 s SHALL result in a non-zero exit with a timeout error

#### Scenario: Default timeout is 600 s when not configured

- **WHEN** `.github/pipeline.yml` does not set `intake_timeout`
- **THEN** the `timeoutSec` argument to `invoke()` SHALL be 600

