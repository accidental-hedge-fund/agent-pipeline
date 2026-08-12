## MODIFIED Requirements

### Requirement: Worktree must be clean around a trusted run

Before the first run the worktree SHALL be clean of **product-relevant**
uncommitted changes; product dirt SHALL block (attempts 0) because results would
be untrustworthy. Non-product scratch paths classified by the
`test-gate-non-product-dirty` capability (engine-known paths such as
`tasks/todo.md`, `.pipeline-prompt-*`, and
`artifacts/challenge-response-*.json`, plus any configured extensions of that
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
  classification (e.g. `tasks/todo.md` or `artifacts/challenge-response-*.json`)
- **AND** no product path is uncommitted
- **THEN** the gate SHALL NOT hard-block solely for that dirt
- **AND** SHALL proceed to run the test/build command (or restore those scratch
  paths first and then run the command)

#### Scenario: challenge-response dump alone does not refuse the gate (#1013)

- **WHEN** the worktree’s only uncommitted path is
  `artifacts/challenge-response-<N>.json`
- **AND** product paths are clean
- **AND** the test gate evaluates the pre-run dirty trust check
- **THEN** the gate SHALL NOT hard-block solely for that path
- **AND** SHALL NOT classify that hold as test/build fix exhaustion for product
  dirt
- **AND** SHALL proceed to invoke the configured or detected test/build command
  (unless optional restore of that path runs first and then the command is
  invoked)

#### Scenario: passing run leaves product artifacts

- **WHEN** the command exits 0 but leaves the tree dirty with product-relevant paths
- **THEN** the gate SHALL block rather than report success

#### Scenario: passing run leaves only scratch dirt

- **WHEN** the command exits 0
- **AND** the only uncommitted paths match non-product scratch classification
  (including engine-known challenge-response dumps)
- **THEN** the gate SHALL NOT hard-block solely for that scratch
- **AND** SHALL report success for the post-run dirty-trust check
