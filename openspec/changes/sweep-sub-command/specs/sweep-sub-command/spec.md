## ADDED Requirements

### Requirement: The `sweep` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `sweep` as a positional sub-command keyword that requires no issue number and that does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `sweep` (case-sensitive). Without `--apply` the command SHALL run in preview (dry-run) mode and write nothing to GitHub. The sub-command SHALL be listed in the CLI help text alongside peer no-issue-number sub-commands.

#### Scenario: Invoked with no flags (dry-run mode)

- **WHEN** the user runs `pipeline sweep`
- **THEN** the command SHALL dispatch the sweep handler, run all phases (classify, re-spec thin issues, reconcile roadmap), and print the summary report without writing anything to GitHub

#### Scenario: Invoked with `--apply`

- **WHEN** the user runs `pipeline sweep --apply`
- **THEN** the command SHALL run all phases and apply writes: issue descriptions updated in place, roadmap change delivered as a branch + PR

#### Scenario: Preview notice is printed when `--apply` is absent

- **WHEN** the user runs `pipeline sweep` without `--apply`
- **THEN** the command SHALL print a notice explaining that no writes will occur and that `--apply` is required to commit changes

---

### Requirement: The `sweep` sub-command SHALL classify each open issue as sufficient or thin without a model call

For each open issue in the target repo, the handler SHALL apply a deterministic structural heuristic to classify it as **sufficient** (skip) or **thin** (re-spec). The heuristic SHALL check: (a) body character count is above a minimum threshold (default 150 characters), (b) at least two of the required section headings are present (Summary, User story, Acceptance criteria, Out of scope), and (c) the body is not a single sentence. An issue meeting all three criteria SHALL be classified as sufficient and skipped without a model call. The minimum threshold and required sections SHALL be tunable via `config.sweep.min_body_length` and `config.sweep.required_sections` in `.github/pipeline.yml`.

#### Scenario: Sufficient issue is classified without a model call

- **WHEN** an open issue has a body of 400 characters with Summary, User story, and Acceptance criteria sections
- **THEN** the handler SHALL classify it as sufficient
- **AND** no model harness call SHALL be made for that issue

#### Scenario: Single-sentence body is classified as thin

- **WHEN** an open issue has a body consisting of one sentence (no section headings, under 150 characters)
- **THEN** the handler SHALL classify it as thin and enqueue it for re-speccing

#### Scenario: Missing required sections marks an issue as thin

- **WHEN** an open issue has a long body but contains only one required section heading
- **THEN** the handler SHALL classify it as thin regardless of body length

#### Scenario: Sufficiency thresholds are configurable

- **WHEN** `.github/pipeline.yml` contains `sweep: { min_body_length: 300 }`
- **THEN** an issue with a 200-character body (and correct headings) SHALL be classified as thin

---

### Requirement: The `sweep` sub-command SHALL re-spec each thin issue via a single model harness call

For each thin issue, the handler SHALL invoke exactly one model harness call that generates an implementable spec body following the WHAT-not-HOW / observable-AC contract: **Summary**, **User story** (`As a … / I want … / so that …`), **Acceptance criteria** (checkable `- [ ]` items stating observable, falsifiable behaviors), **Out of scope** (explicit exclusions), and **Open questions** only when the existing context is genuinely ambiguous. The existing issue title and body SHALL be passed as input context; the generated spec SHALL preserve the author's original intent and not discard existing context. The spec SHALL describe WHAT and WHY — never HOW.

#### Scenario: Generated spec follows the contract

- **WHEN** a thin issue with title "add retry logic" and a two-sentence body is re-specced
- **THEN** the generated body SHALL contain Summary, User story, Acceptance criteria, and Out of scope sections
- **AND** each acceptance criterion SHALL be a testable, observable outcome (not an approach step)

#### Scenario: Author context is preserved

- **WHEN** an existing thin issue body contains a user-specific constraint ("must work with SAML providers")
- **THEN** the generated spec SHALL include that constraint in one of its sections (Acceptance criteria or Out of scope)
- **AND** the constraint SHALL NOT be silently discarded

#### Scenario: Open questions appear only when genuinely ambiguous

- **WHEN** a thin issue provides enough context to spec without unresolved decisions
- **THEN** the generated spec SHALL NOT include an Open questions section

#### Scenario: Spec generation is the only model-invoking step

- **WHEN** the sweep handler runs on a backlog of N thin issues
- **THEN** exactly N model harness calls SHALL be made (one per thin issue)
- **AND** all subsequent steps (issue body update, roadmap reconciliation) SHALL be deterministic given the generated specs

---

### Requirement: The `sweep` sub-command SHALL update thin issue descriptions in place when `--apply` is provided

Under `--apply`, the handler SHALL call the GitHub API to update each thin issue's body with the generated spec text. Sufficient issues SHALL NOT be modified. The update SHALL be idempotent: if the same sweep run is applied twice, the second run SHALL recognize the updated body as sufficient and skip it.

#### Scenario: Thin issue body is updated under `--apply`

- **WHEN** `pipeline sweep --apply` runs and an issue is classified as thin
- **THEN** the issue body on GitHub SHALL be replaced with the generated spec

#### Scenario: Sufficient issue is not modified

- **WHEN** `pipeline sweep --apply` runs and an issue is classified as sufficient
- **THEN** the issue body on GitHub SHALL remain unchanged

#### Scenario: Second sweep run skips previously re-specced issues

- **WHEN** `pipeline sweep --apply` is run a second time on the same repo
- **THEN** issues re-specced by the first run SHALL be classified as sufficient and skipped
- **AND** no model harness call SHALL be made for those issues

---

### Requirement: The `sweep` sub-command SHALL reconcile `ROADMAP.md` and deliver the update as a branch and PR

After completing issue classification and (optionally) re-speccing, the handler SHALL re-evaluate `ROADMAP.md` against the current open backlog and propose a synchronized update that keeps all three ROADMAP structures consistent: the release-plan table, the per-issue sem-ver table, and the per-release detail sections. The update SHALL be committed on a new branch and a PR opened targeting the default branch. The handler SHALL NOT commit directly to the default branch.

Under dry-run mode (no `--apply`), the handler SHALL print the proposed ROADMAP diff without creating a branch or PR.

If, under `--apply`, the roadmap delivery (write → commit → push → PR) fails AFTER any issue body has been rewritten, the handler SHALL print the summary and step-aware recovery instructions and then SHALL propagate a failure (exit non-zero), so automation keying off exit status does not treat the partial bulk mutation (issues rewritten, ROADMAP PR missing) as a complete success. The recovery instructions SHALL match the failed step: when no reconciliation commit exists (a write or commit failure), they SHALL instruct the user to (re)create the ROADMAP.md commit on the reserved branch before pushing and opening the PR; when the commit already exists (a push or PR failure), they SHALL instruct only the push and PR.

#### Scenario: Roadmap reconciliation PR is opened under `--apply`

- **WHEN** `pipeline sweep --apply` completes
- **THEN** a new branch SHALL be created containing the ROADMAP.md reconciliation
- **AND** a PR targeting the default branch SHALL be opened
- **AND** no direct commit to the default branch SHALL occur

#### Scenario: Roadmap delivery failure after issue rewrites exits non-zero

- **WHEN** `pipeline sweep --apply` rewrites one or more issue bodies but the roadmap branch/PR delivery then fails
- **THEN** the handler SHALL print the summary and recovery instructions
- **AND** SHALL exit non-zero (propagate a failure) rather than reporting success for the partial mutation

#### Scenario: Recovery instructions match the failed delivery step

- **WHEN** the delivery fails before a reconciliation commit exists on the branch (a `ROADMAP.md` write or commit failure)
- **THEN** the recovery instructions SHALL tell the user to inspect/repair `ROADMAP.md` and create the commit on the reserved branch before pushing and opening the PR
- **AND WHEN** the delivery fails after the commit exists (a push or PR-create failure)
- **THEN** the recovery instructions SHALL tell the user only to push the reserved branch and open the PR

#### Scenario: All three ROADMAP structures are updated consistently

- **WHEN** a new open issue is not yet present in ROADMAP.md
- **THEN** the reconciliation SHALL add a release-plan table row, a per-issue sem-ver table row, and a detail-section bullet for that issue
- **AND** all three SHALL reference the same issue number and proposed release version

#### Scenario: Existing roadmap entries are not duplicated

- **WHEN** an issue is already present in all three ROADMAP structures
- **THEN** the reconciliation SHALL leave those entries unchanged and SHALL NOT add duplicate rows

#### Scenario: Dry-run prints roadmap diff without creating a branch

- **WHEN** `pipeline sweep` runs without `--apply`
- **THEN** the proposed ROADMAP diff SHALL be printed to stdout
- **AND** no branch SHALL be created and no PR SHALL be opened

---

### Requirement: The `sweep` sub-command SHALL end with a structured summary report

Regardless of `--apply`, the handler SHALL print a summary report to stdout containing: (1) a per-issue line with issue number, title, action taken (`specced` / `left-as-is` / `blocked`), and a one-line reason; (2) aggregate counts (issues inspected, re-specced, skipped, blocked); (3) the roadmap delta (issues added, updated, or unchanged); and (4) whether writes were applied or only previewed.

#### Scenario: Report includes per-issue action and reason

- **WHEN** `pipeline sweep` completes on a backlog of 10 issues (3 thin, 7 sufficient)
- **THEN** the report SHALL list all 10 issues with their action
- **AND** each line SHALL include a one-line reason (e.g. "body length 45 chars, missing sections" or "already complete")

#### Scenario: Report includes aggregate counts

- **WHEN** `pipeline sweep` completes
- **THEN** the report SHALL include a summary line such as "10 inspected, 3 re-specced, 7 left-as-is, 0 blocked"

#### Scenario: Blocked issue appears in report with a reason

- **WHEN** a harness call for a thin issue fails (e.g. timeout or rate-limit)
- **THEN** that issue SHALL appear in the report with action `blocked` and the failure reason
- **AND** the sweep SHALL continue processing remaining issues rather than aborting

---

### Requirement: The `sweep` handler SHALL use injectable I/O deps for all external calls

All external calls (GitHub issue listing, body reads, body writes, model harness, file reads/writes, git branch/PR creation) SHALL be injected via a `SweepDeps` interface so unit tests can substitute fakes. No real network, git, or subprocess calls SHALL occur in unit tests.

#### Scenario: Unit tests exercise all branches via fakes

- **WHEN** sweep tests run using a fake `SweepDeps`
- **THEN** no real `gh` CLI, harness, or filesystem call SHALL be made
- **AND** the tests SHALL cover: dry-run path, `--apply` path, sufficient-issue skip, thin-issue re-spec, blocked-issue continue, idempotent re-run, and roadmap-PR creation
