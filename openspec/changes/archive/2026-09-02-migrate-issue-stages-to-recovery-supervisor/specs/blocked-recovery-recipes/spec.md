## ADDED Requirements

### Requirement: setBlocked SHALL project lifecycle state and SHALL NOT choose treatment

`setBlocked` SHALL remain the GitHub compatibility projector for blocked comments, recipes, and the `blocked` label. RecoverySupervisor SHALL choose treatment, Cooling, wait, typed request, and re-entry. A `setBlocked` call from an issue-stage adapter SHALL NOT mark the Logical Operation complete, cancelled, or human-owned unless a genuine current `human-decision-required` diagnostic with current candidate-bound authority evidence exists. Kind-specific recipes in `BLOCKER_RECIPES` SHALL remain projection text.

#### Scenario: Mechanical block projection stays owned

- **WHEN** an issue-stage adapter reports a harness-failure observation
- **AND** the lifecycle projector emits `setBlocked` with `blockerKind: "harness-failure"`
- **THEN** the Logical Operation SHALL remain owned
- **AND** RecoverySupervisor SHALL retain treatment selection

#### Scenario: Missing kind still projects needs-human recipe text

- **WHEN** `setBlocked(cfg, N, reason, stage)` is called without a `kind` argument
- **THEN** the comment SHALL render the `needs-human` recipe text
- **AND** that projection SHALL NOT by itself create a genuine Authority Request
