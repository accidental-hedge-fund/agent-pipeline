## ADDED Requirements

### Requirement: Format gate runs after implementing and fix-round harnesses

After the implementing harness exits (and after existing salvage/verify passes) and after each fix-round harness exits, the pipeline SHALL run every entry in `config.format_gate` (in declaration order) inside the worktree. If `format_gate` is absent or empty, this step is a no-op and the pipeline proceeds unchanged.

#### Scenario: No format_gate configured — step is skipped

- **WHEN** `.github/pipeline.yml` does not include a `format_gate:` key
- **THEN** the pipeline SHALL proceed directly to the test gate without running any format commands

#### Scenario: Format gate runs in order after implementing harness

- **WHEN** `format_gate` is configured with two entries and the implementing harness exits 0
- **THEN** the pipeline SHALL run entry 1 first, then entry 2, in the worktree root
- **AND** only after both succeed SHALL the pipeline proceed to the test gate

### Requirement: Auto-fix entries mutate the worktree and commit the diff

For each `format_gate` entry with `auto_fix: true`, the pipeline SHALL run the command, check the worktree for uncommitted changes, and if changes are present, commit them with the message `chore: auto-format (#<issue_number>)`. The pipeline SHALL then re-run the same command to verify the fix is stable; if the re-run exits non-zero, the pipeline SHALL block.

#### Scenario: Pre-existing uncommitted changes block format gate before auto-fix runs

- **WHEN** the worktree contains uncommitted changes before `runFormatGate` is invoked
- **AND** at least one `format_gate` entry has `auto_fix: true`
- **THEN** the pipeline SHALL block with reason containing "pre-existing uncommitted changes"
- **AND** SHALL NOT run any format gate commands

#### Scenario: Auto-fix command produces changes — commit is created

- **WHEN** a `format_gate` entry has `auto_fix: true` (e.g. `cargo fmt`)
- **AND** the command exits 0 and leaves uncommitted changes in the worktree
- **THEN** the pipeline SHALL commit those changes with message `chore: auto-format (#<issue_number>)`
- **AND** re-run the same command
- **AND** if the re-run exits 0, proceed to the next format gate entry

#### Scenario: Auto-fix command is already clean — no commit created

- **WHEN** a `format_gate` entry has `auto_fix: true`
- **AND** the command exits 0 and leaves no uncommitted changes
- **THEN** the pipeline SHALL NOT create a commit and SHALL proceed to the next entry

#### Scenario: Auto-fix commit fails — pipeline blocks

- **WHEN** a `format_gate` entry has `auto_fix: true`
- **AND** the command exits 0 and leaves uncommitted changes in the worktree
- **AND** the `git add` or `git commit` step exits non-zero
- **THEN** the pipeline SHALL block with reason containing "auto-format commit failed" and the git error output
- **AND** SHALL NOT open or update the PR

#### Scenario: Auto-fix re-run exits non-zero — pipeline blocks

- **WHEN** a `format_gate` entry has `auto_fix: true`
- **AND** the command exits 0 but the re-run after committing still exits non-zero
- **THEN** the pipeline SHALL block with reason containing the command name and its non-zero exit output
- **AND** SHALL NOT open or update the PR

### Requirement: Check-only entries block on non-zero exit without committing

For each `format_gate` entry with `auto_fix: false`, the pipeline SHALL run the command and if it exits non-zero, SHALL block immediately with the command's combined stdout+stderr as the reason. No worktree mutation or commit occurs for check-only entries.

#### Scenario: Check-only command passes

- **WHEN** a `format_gate` entry has `auto_fix: false` (e.g. `cargo clippy -D warnings`)
- **AND** the command exits 0
- **THEN** the pipeline SHALL proceed to the next entry

#### Scenario: Check-only command fails — pipeline blocks

- **WHEN** a `format_gate` entry has `auto_fix: false`
- **AND** the command exits non-zero
- **THEN** the pipeline SHALL block with reason `"Format gate command '<cmd>' failed:\n<output>"` where `<output>` is the combined stdout+stderr
- **AND** SHALL NOT open or update the PR

### Requirement: Auto-format commits are classified as pipeline-internal

The `isPipelineInternalCommit` predicate SHALL recognize commits whose message begins with `chore: auto-format (#` as pipeline-internal, so the review-SHA gate does not re-trigger a full review cycle on a pure formatting commit.

#### Scenario: Auto-format commit does not re-trigger review

- **WHEN** the only new commit since the last review verdict begins with `chore: auto-format (#`
- **THEN** `isPipelineInternalCommit` SHALL return `true` for that commit
- **AND** the review-SHA gate SHALL NOT invalidate the existing verdict

#### Scenario: Developer commit alongside auto-format commit does re-trigger review

- **WHEN** new commits include both a `chore: auto-format (#` commit and a developer commit (e.g. `fix:` prefix)
- **THEN** the review-SHA gate SHALL treat the developer commit as non-internal
- **AND** SHALL re-trigger review as normal

### Requirement: Format gate has regression tests with injectable deps

The `runFormatGate` function SHALL accept a `deps` parameter (following the existing `AdvanceReviewDeps` / `ShaGateDeps` pattern) so unit tests can mock command execution and git operations without real subprocess calls. At minimum, the test suite SHALL include: a no-op test (empty config), an auto-fix test where changes are produced and committed, an auto-fix re-run-failure test (blocks), and a check-only failure test (blocks).

#### Scenario: Unit test exercises auto-fix path with a fake command

- **WHEN** the test injects a fake `exec` that returns a non-empty diff on the first call and exits 0 on the re-run
- **THEN** the test SHALL assert a `chore: auto-format` commit is created and the gate returns success

#### Scenario: Unit test exercises check-only failure path

- **WHEN** the test injects a fake `exec` that exits non-zero for a check-only entry
- **THEN** the test SHALL assert the gate returns `{ status: "blocked", reason: ... }`
