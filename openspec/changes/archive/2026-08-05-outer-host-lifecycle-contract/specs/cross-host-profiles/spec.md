## ADDED Requirements

### Requirement: Outer-host lifecycle identity SHALL remain independent of profile harness roles

Pipeline profiles (`core/profiles/<name>.json`) SHALL continue to assign implementer and reviewer
harness roles, review mode, and presentation defaults. Outer-host lifecycle identity and lifecycle
capabilities SHALL live on the outer-host manifest/registry, not solely inside profile JSON.
Loading a profile SHALL NOT be the only supported extension path for outer-host install, follow,
reattach, notify, or terminal cleanup capabilities. Outer-host id SHALL NOT be required to equal
`harnesses.implementer` or `harnesses.reviewer`.

#### Scenario: Outer host and profile roles can differ

- **WHEN** an outer host `opencode` launches the pipeline with profile `opencode` whose
  implementer role resolves to adapter `opencode` and reviewer to another adapter
- **THEN** outer-host identity `opencode` SHALL remain a lifecycle identity
- **AND** changing only the reviewer harness role SHALL NOT rewrite the outer-host id

#### Scenario: Profile load is not the outer-host extension path

- **WHEN** an operator adds a third-party outer host with install and follow capabilities
- **THEN** registration SHALL go through the outer-host manifest/registry path
- **AND** SHALL NOT require adding a new profile file as the sole way to declare install/follow
  lifecycle capabilities
