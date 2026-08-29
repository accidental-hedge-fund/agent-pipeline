## ADDED Requirements

### Requirement: Salvage after harness-background-wait SHALL retain evidence without a successful-stage outcome

The pipeline SHALL run the existing salvage path — including the depth-agnostic `node_modules`
exclusion, pipeline-internal marker exclusion, owned-path scope when ownership is present, and
`Issue:` / `Pipeline-Run:` trailers — and SHALL retain that salvage evidence when a
product-mutating harness step ends with reason `harness-background-wait` and the worktree
contains uncommitted salvageable changes. The pipeline SHALL NOT treat that salvage as a
successful harness completion. The pipeline SHALL NOT proceed to the post-commit verification
path as if the harness had committed normally, SHALL NOT reclassify the outcome as
`harness-timeout`, SHALL NOT open a pull request, and SHALL NOT transition to `review-1` solely
because salvage succeeded. Publication of salvaged work remains outside this requirement.

#### Scenario: Dirty worktree after background-wait is salvaged and still background-wait

- **WHEN** an implement, fix-round, or test-fix harness ends as `harness-background-wait`
- **AND** the worktree contains uncommitted salvageable changes
- **THEN** the pipeline SHALL create a salvage commit using the existing salvage path
- **AND** the commit message SHALL begin with `salvage: stage harness work (#<issueNumber>)`
- **AND** the stage outcome SHALL remain `harness-background-wait`
- **AND** SHALL NOT proceed to the test gate as a successful implement

#### Scenario: Salvage failure is disclosed and the outcome stays harness-background-wait

- **WHEN** salvage is attempted after `harness-background-wait` and the salvage git operation
  fails
- **THEN** the captured salvage failure reason SHALL be retained on the diagnostic evidence
- **AND** the stage outcome SHALL remain `harness-background-wait`
- **AND** SHALL NOT be rewritten as a bare no-commit harness-failure without salvage detail

#### Scenario: Clean tree after background-wait does not salvage

- **WHEN** a harness ends as `harness-background-wait` with a clean worktree
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** the outcome SHALL remain `harness-background-wait`
