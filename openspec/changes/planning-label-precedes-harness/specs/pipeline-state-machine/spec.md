## ADDED Requirements

### Requirement: Planning label precedes harness invocation

The planning stage SHALL transition the issue `ready → planning` (set the `pipeline:planning`
label) BEFORE invoking any planning harness, so the label reflects active work for the entire
harness duration rather than leaving the issue on `pipeline:ready` until authoring finishes.

While the planning stage is executing — from the moment it begins until it transitions to
`plan-review` (when plan review is enabled) or `implementing` (when it is not) — any block it
raises SHALL classify the stage as `planning`, never `ready`. This applies to every
planning-stage block path: worktree-creation failure, worktree-setup failure, plan-generation
(artifact authoring) failure, and OpenSpec structural-validation failure.

This requirement governs only the planning-stage label timing and the stage classification of
planning-stage blocks. The `planning → plan-review` and `planning → implementing` transitions,
and any blocks raised after the `plan-review` transition (which are classified `plan-review`),
are unaffected.

#### Scenario: planning label is set before the authoring harness runs

- **WHEN** the planning stage begins for an issue on `pipeline:ready` (not a dry run)
- **THEN** the stage SHALL transition `ready → planning` before calling the artifact-authoring
  harness
- **AND** the authoring harness SHALL observe the issue already on `pipeline:planning`

#### Scenario: planning-stage blocks classify the stage as planning

- **WHEN** a block is raised while the planning stage is executing (before the `plan-review`
  or `implementing` transition) — for any of: worktree-creation failure, worktree-setup
  failure, plan-generation failure, or OpenSpec validation failure
- **THEN** `setBlocked` SHALL be called with stage `planning`
- **AND** SHALL NOT be called with stage `ready`

#### Scenario: downstream transitions are unaffected

- **WHEN** the planning stage authors a valid artifact and plan review is enabled
- **THEN** it SHALL transition `planning → plan-review` and later `plan-review → implementing`
  exactly as before
- **WHEN** plan review is disabled
- **THEN** it SHALL transition `planning → implementing` directly, exactly as before
