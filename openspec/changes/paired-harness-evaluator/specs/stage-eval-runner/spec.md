## MODIFIED Requirements

### Requirement: A versioned experiment manifest SHALL define the experiment

The runner SHALL accept either its existing Cartesian `treatments` axes or explicit `named_treatments`, but not both. A named treatment shall declare its stable treatment identifier and valid coordinate data before execution. The runner SHALL validate the selected treatment form before any treatment runs.

#### Scenario: Existing Cartesian manifests remain valid

- **WHEN** a manifest declares only the existing `treatments` axes
- **THEN** validation and expansion SHALL preserve the existing treatment ids and cells

#### Scenario: Mixed treatment forms are rejected

- **WHEN** a manifest declares both `treatments` and `named_treatments`
- **THEN** manifest validation SHALL fail before any worktree or harness invocation

### Requirement: The runner SHALL support independent stage execution, paired execution, and end-to-end execution

In addition to the existing modes, the runner SHALL support `paired` mode as defined by the paired-harness-evaluation capability. The paired mode SHALL use a fresh isolated worktree and SHALL record one result per pair treatment and replicate.

#### Scenario: Paired mode is independently invocable

- **WHEN** an experiment declares `mode: "paired"`
- **THEN** it SHALL invoke only the paired trajectory for each cell
- **AND** SHALL NOT enter the production label-driven state machine
