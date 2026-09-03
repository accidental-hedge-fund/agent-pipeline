## Purpose

Binds OpenSpec plan-review resume, and later revision in that session, to the current worktree change files so the reviewer judges living `proposal.md` and spec deltas instead of a stale GitHub plan comment.

## ADDED Requirements

### Requirement: OpenSpec plan-review resume SHALL pass the worktree proposal and spec deltas to the reviewer

OpenSpec plan-review resume SHALL pass the current worktree `proposal.md` as the plan text in the plan-review prompt when the worktree has one restorable in-flight change. The pipeline SHALL also pass that change's current spec deltas as spec context in the same prompt. The GitHub `## Implementation Plan` or `## Revised Implementation Plan` comment SHALL NOT be the sole plan text in that prompt when the worktree `proposal.md` differs from the comment. Resume SHALL NOT re-invoke the planning authoring harness to obtain those artifacts.

#### Scenario: Resume reviews the worktree proposal, not the older comment

- **WHEN** plan-review resume runs on an OpenSpec worktree with one restorable in-flight change
- **AND** the worktree `proposal.md` contains text that is absent from the latest GitHub plan comment
- **THEN** the plan-review prompt SHALL include the worktree `proposal.md` text as plan text
- **AND** SHALL include the worktree spec deltas as spec context
- **AND** SHALL NOT use the GitHub plan comment as the sole plan text

#### Scenario: Prior revision pins in the worktree are visible to the reviewer

- **WHEN** plan-review resume runs after a `NEEDS_REVISION` round
- **AND** the worktree `proposal.md` already contains the pins the prior review required
- **AND** the latest GitHub plan comment does not contain those pins
- **THEN** the plan-review prompt SHALL include those pins from the worktree `proposal.md`
- **AND** SHALL NOT present the older comment as the only plan the reviewer must judge

#### Scenario: Resume still skips authoring

- **WHEN** plan-review resume is requested and a completed plan comment exists
- **THEN** the pipeline SHALL NOT re-invoke the planning authoring harness solely to bind worktree artifacts

### Requirement: Later plan revision on that resume SHALL use the same worktree artifacts

The pipeline SHALL pass the bound worktree `proposal.md` and spec deltas to any plan-revision prompt in the same OpenSpec plan-review resume session. The GitHub plan comment SHALL NOT be the sole plan text for that revision prompt when a singular restorable change exists.

#### Scenario: Revision prompt after resume uses the worktree proposal

- **WHEN** OpenSpec plan-review resume binds the worktree `proposal.md` and spec deltas
- **AND** plan-review returns `NEEDS_REVISION`
- **THEN** the plan-revision prompt SHALL include that worktree `proposal.md` as plan text
- **AND** SHALL include those spec deltas as spec context
- **AND** SHALL NOT use the GitHub plan comment as the sole plan text

### Requirement: Freeform plan-review resume SHALL keep using the GitHub plan comment

Freeform plan-review resume SHALL keep using the latest GitHub plan comment as plan text. The pipeline SHALL NOT require an OpenSpec change directory on that path.

#### Scenario: Freeform resume is unchanged

- **WHEN** plan-review resume runs and the OpenSpec planning flow is not active
- **AND** a completed GitHub plan comment exists
- **THEN** the plan-review prompt SHALL use that comment as plan text
- **AND** SHALL NOT fail for the absence of an OpenSpec change directory

### Requirement: Non-singular OpenSpec resume SHALL block with the named restore reason

OpenSpec plan-review resume SHALL block with the named change-id restore reason when restore cannot choose exactly one in-flight change. The pipeline SHALL NOT treat the GitHub plan comment as a living OpenSpec proposal in that case. The pipeline SHALL NOT invent a second blocker kind for this failure.

#### Scenario: Zero restorable changes blocks without comment-as-proposal

- **WHEN** OpenSpec plan-review resume needs living change artifacts
- **AND** the worktree has zero active OpenSpec changes
- **THEN** the stage SHALL block at plan-review
- **AND** the blocker reason SHALL name change-id restore failure
- **AND** the plan-review harness SHALL NOT be invoked with the GitHub plan comment as an OpenSpec proposal

#### Scenario: Multiple candidate changes block without picking one

- **WHEN** OpenSpec plan-review resume needs living change artifacts
- **AND** restore sees more than one change that is not in the pre-worktree baseline
- **THEN** the stage SHALL block at plan-review
- **AND** the blocker reason SHALL name change-id restore failure
- **AND** SHALL NOT select an arbitrary change among many as the plan text

### Requirement: Resume artifact binding SHALL reuse the existing singularity and file readers

OpenSpec plan-review resume SHALL select the in-flight change with the same acceptance criteria as `openspec.change-singular@1`. Resume SHALL read `proposal.md` and spec deltas from that change directory with the same file readers first-pass authoring uses. Binding SHALL NOT invent a second discovery parser, durable identity store, or plan-comment scrape as the source of the living plan. Binding SHALL NOT add a merge-authority path or change the review verdict schema.

#### Scenario: Unique change not in the baseline is the living plan

- **WHEN** the worktree active-change list contains exactly one id that is absent from the pre-worktree baseline
- **THEN** resume SHALL bind that change's `proposal.md` and spec deltas
- **AND** SHALL NOT scrape the GitHub plan comment to choose the change id

#### Scenario: Exactly one active change is bound when the baseline already contains it

- **WHEN** the worktree has exactly one active change
- **AND** that change is also present in the pre-worktree baseline
- **THEN** resume SHALL bind that single active change's `proposal.md` and spec deltas

#### Scenario: Train merge and review schema stay unchanged

- **WHEN** this change is implemented
- **THEN** train, merge-authority, and review-schema behavior SHALL remain unchanged
- **AND** plan-review resume SHALL still skip authoring

### Requirement: A regression SHALL fail if resume ignores the worktree proposal

A co-located unit test SHALL fail if OpenSpec plan-review resume with a singular restorable change passes the reviewer only the GitHub plan comment while the worktree `proposal.md` contains different text. Tests SHALL inject the GitHub plan comment and the worktree `proposal.md` / spec-delta reads. Tests SHALL perform no live GitHub, git, or subprocess calls.

#### Scenario: Regression bites comment-only resume

- **WHEN** a unit test drives OpenSpec plan-review resume with one restorable change
- **AND** the injected worktree `proposal.md` contains pins that the injected GitHub plan comment lacks
- **AND** the plan-review prompt receives only the comment text as plan text
- **THEN** the test SHALL fail

#### Scenario: Injected seams stay hermetic

- **WHEN** the resume artifact-binding tests run
- **THEN** they SHALL inject comment bodies and worktree proposal / spec-delta reads
- **AND** SHALL perform no live GitHub, git, or subprocess calls
