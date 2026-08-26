## MODIFIED Requirements

### Requirement: Auto-fix entries mutate the worktree and commit the diff

For each `format_gate` entry with `auto_fix: true`, the pipeline SHALL run the command, check the worktree for uncommitted changes, and if changes are present, commit them with the message `chore: auto-format (#<issue_number>)`. The pipeline SHALL then re-run the same command to verify the fix is stable; if the re-run exits non-zero, the pipeline SHALL block.

Unknown pre-existing product dirt SHALL still block the gate before any auto-fix command runs. Pipeline-owned harness leftovers (see `harness-mutation-ownership`) SHALL NOT satisfy that unknown-dirt guard. The format gate SHALL NOT commit owned leftovers as `chore: auto-format`. Ownership recovery/checkpoint SHALL run before this pre-flight treats the worktree as unknown-dirty.

#### Scenario: Pre-existing uncommitted changes block format gate before auto-fix runs

- **WHEN** the worktree contains uncommitted changes before `runFormatGate` is invoked
- **AND** those changes are unknown product dirt (no ownership record, or paths outside the owned leftover set)
- **AND** at least one `format_gate` entry has `auto_fix: true`
- **THEN** the pipeline SHALL block with reason containing "pre-existing uncommitted changes"
- **AND** SHALL NOT run any format gate commands

#### Scenario: Pipeline-owned harness leftovers do not trip the unknown-dirt pre-flight

- **WHEN** the worktree contains uncommitted product paths classified as pipeline-owned harness leftovers
- **AND** no unknown product dirt remains
- **AND** at least one `format_gate` entry has `auto_fix: true`
- **THEN** the pipeline SHALL NOT block with reason containing "pre-existing uncommitted changes" solely for those owned leftovers
- **AND** SHALL NOT commit those leftovers as `chore: auto-format`
- **AND** ownership checkpoint or equivalent recovery SHALL have already authored them, or SHALL run before auto-fix

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
