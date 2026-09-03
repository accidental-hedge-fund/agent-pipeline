## Purpose

Restores the singular in-flight OpenSpec change id when plan-review resume skips authoring, and refuses empty names on single-item OpenSpec validation so the next identical empty-name fault does not need a new mole issue.

## ADDED Requirements

### Requirement: Plan-review resume SHALL restore the singular OpenSpec change id before validation

OpenSpec plan-review resume SHALL restore the singular in-flight change id from the issue worktree before any single-item OpenSpec validation call. Resume SHALL NOT re-invoke the planning authoring harness to obtain that id. Restore SHALL run even when the in-process closed-over change id is empty because authoring was skipped.

#### Scenario: Resume with one in-flight change validates that change after revision

- **WHEN** plan-review resume runs on an OpenSpec worktree that has one restorable in-flight change
- **AND** plan-review returns `NEEDS_REVISION`
- **AND** the revision harness exits successfully
- **THEN** single-item OpenSpec validation SHALL run against that restored change id
- **AND** SHALL NOT pass an empty item name to the OpenSpec CLI

#### Scenario: Resume still skips authoring

- **WHEN** plan-review resume is requested and a completed plan comment exists
- **THEN** the pipeline SHALL reuse the completed plan
- **AND** SHALL NOT re-invoke the planning authoring harness solely to recover the change id

### Requirement: Change-id restore SHALL reuse the existing singularity contract

OpenSpec change-id restore SHALL select the in-flight change with the same acceptance criteria as `openspec.change-singular@1`. Restore SHALL prefer the unique active change that is not in the pre-worktree baseline. If that set is empty and the worktree has exactly one active change, restore SHALL use that change. Restore SHALL NOT invent a second discovery parser, durable identity store, or plan-comment scrape as the source of truth.

#### Scenario: Unique change not in the baseline is restored

- **WHEN** the worktree active-change list contains exactly one id that is absent from the pre-worktree baseline
- **THEN** restore SHALL choose that id
- **AND** SHALL pass that id to single-item validation

#### Scenario: Exactly one active change is restored when the baseline already contains it

- **WHEN** the worktree has exactly one active change
- **AND** that change is also present in the pre-worktree baseline
- **THEN** restore SHALL choose that single active change
- **AND** SHALL pass that id to single-item validation

### Requirement: Single-item OpenSpec validation SHALL refuse an empty item name

The pipeline's single-item OpenSpec validation entry SHALL refuse an empty or whitespace-only item name. It SHALL NOT spawn the OpenSpec CLI with that empty name. The refusal SHALL apply to every caller of that entry, not only plan-review resume.

#### Scenario: Empty name does not spawn the CLI

- **WHEN** single-item OpenSpec validation is invoked with `""` or a whitespace-only name
- **THEN** the entry SHALL return an invalid result without spawning the OpenSpec CLI
- **AND** the result SHALL NOT include the CLI text `Nothing to validate`

#### Scenario: A later empty-name caller hits the same gate

- **WHEN** any pipeline path other than plan-review resume invokes single-item validation with an empty name
- **THEN** the same empty-name refusal SHALL apply
- **AND** a new mole issue SHALL NOT be required for that empty-name class

### Requirement: Non-singular restore SHALL block with a named reason

When restore cannot choose exactly one in-flight change id, the plan-review path SHALL block with a named reason that states change-id restore failed. The reason SHALL include the singularity diagnostic. The path SHALL NOT invoke single-item validation with an empty name. The path SHALL NOT treat the CLI text `Nothing to validate` as the operator-facing reason. The path SHALL NOT add a new blocker kind or recovery recipe for this failure.

#### Scenario: No restorable change blocks with a named reason

- **WHEN** plan-review resume needs OpenSpec validation
- **AND** the worktree has zero active changes
- **THEN** the stage SHALL block at plan-review
- **AND** the blocker reason SHALL name change-id restore failure
- **AND** the reason SHALL NOT include `Nothing to validate`
- **AND** single-item validation SHALL NOT be invoked with `""`

#### Scenario: Multiple candidate changes block without picking one

- **WHEN** plan-review resume needs OpenSpec validation
- **AND** restore sees more than one change that is not in the pre-worktree baseline
- **THEN** the stage SHALL block at plan-review
- **AND** the blocker reason SHALL name change-id restore failure
- **AND** SHALL NOT select an arbitrary change among many
- **AND** single-item validation SHALL NOT be invoked with `""`

### Requirement: Resume-plus-revision regressions SHALL fail on empty validation names

A co-located unit test SHALL fail if plan-review resume followed by revision validates an empty item name or skips restore when a singular change is restorable. Tests SHALL inject change-directory listing and single-item validation. Tests SHALL perform no live network, git, or subprocess calls. This change SHALL NOT alter train, merge-authority, or review-policy behavior.

#### Scenario: Regression bites empty-name resume

- **WHEN** a unit test drives OpenSpec plan-review resume with one restorable change and a successful revision
- **AND** restore is skipped or the restored id is empty
- **THEN** the test SHALL fail
- **AND** the test SHALL record the item name passed to single-item validation

#### Scenario: Injected seams stay hermetic

- **WHEN** the restore and empty-name tests run
- **THEN** they SHALL inject change-directory listing and single-item validation fakes
- **AND** SHALL perform no live network, git, or subprocess calls

#### Scenario: Train merge and review policy stay unchanged

- **WHEN** this change is implemented
- **THEN** train, merge-authority, and review-policy behavior SHALL remain unchanged
- **AND** plan-review resume SHALL still skip authoring
