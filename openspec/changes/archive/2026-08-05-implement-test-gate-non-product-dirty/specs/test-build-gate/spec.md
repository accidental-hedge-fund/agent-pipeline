## MODIFIED Requirements

### Requirement: Worktree must be clean around a trusted run

Before the first run the worktree SHALL be clean of **product-relevant**
uncommitted changes; product dirt SHALL block (attempts 0) because results would
be untrustworthy. Non-product scratch paths classified by the
`test-gate-non-product-dirty` capability (engine-known paths such as
`tasks/todo.md` and `.pipeline-prompt-*`, plus any configured extensions of that
set) SHALL NOT alone cause this pre-run hard block. After a passing run the tree
SHALL still be free of product-relevant uncommitted artifacts; if the run
produced uncommitted **product** artifacts the gate SHALL block (the committed
state differs from the tested state). Post-run dirt that is exclusively
non-product scratch SHALL NOT alone cause a hard block. Recognized lock-file
side-effects remain out of band: they are folded before gates when applicable
and are not treated as ignorable scratch.

#### Scenario: dirty before the first run

- **WHEN** the worktree has uncommitted **product** changes before the gate runs
- **THEN** the gate SHALL block with attempts 0 and SHALL NOT invoke the fix harness

#### Scenario: scratch-only dirty before the first run is not a hard block

- **WHEN** the worktree’s only uncommitted paths match the non-product scratch
  classification (e.g. `tasks/todo.md`)
- **AND** no product path is uncommitted
- **THEN** the gate SHALL NOT hard-block solely for that dirt
- **AND** SHALL proceed to run the test/build command (or restore those scratch
  paths first and then run the command)

#### Scenario: passing run leaves product artifacts

- **WHEN** the command exits 0 but leaves the tree dirty with product-relevant paths
- **THEN** the gate SHALL block rather than report success

#### Scenario: passing run leaves only scratch dirt

- **WHEN** the command exits 0
- **AND** the only uncommitted paths match non-product scratch classification
- **THEN** the gate SHALL NOT hard-block solely for that scratch
- **AND** SHALL report success for the post-run dirty-trust check

## ADDED Requirements

### Requirement: Pre-run dirty path disclosure SHALL emphasize product paths

The test/build gate `blockReason` SHALL include the offending **product** paths
from porcelain status when the gate hard-blocks because of product-relevant
uncommitted changes (truncated via the existing output-cap helper when long).
Paths classified as non-product scratch MAY be omitted from the blocking
disclosure or listed separately as non-blocking; they SHALL NOT be the sole
paths that cause a hard block. When the gate does not block on a dirty tree, the
reason SHALL be unchanged. Path capture remains injectable for unit testing
without real git.

#### Scenario: product dirty block names product paths

- **WHEN** the worktree has an uncommitted product path before the gate runs
- **THEN** the gate SHALL block with attempts 0
- **AND** the `blockReason` SHALL contain that product path

#### Scenario: mixed dirt does not treat scratch as the sole disclosed failure

- **WHEN** the worktree has both product dirt and non-product scratch dirty
- **THEN** the gate SHALL block
- **AND** the `blockReason` SHALL contain the product path(s)
