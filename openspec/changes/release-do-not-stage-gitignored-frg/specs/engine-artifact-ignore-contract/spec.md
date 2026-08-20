## ADDED Requirements

### Requirement: Engine commands SHALL NOT pass artifact-contract ignore paths as explicit git add pathspecs

The engine SHALL NOT include a path from the exported artifact ignore contract as an explicit `git add` pathspec. That includes `git add -f` of `.agent-pipeline/frg/` or any other contract directory. `git add -A` that silently skips ignored files is allowed. An explicit pathspec of an ignored path is a hard fail. Omitting that pathspec is the product fix. Un-ignoring the path or committing the artifact so `git add` succeeds SHALL NOT be the product fix.

The next identical fault — an engine command that `git add`s a gitignored contract path and dies — SHALL fail the same tests. It SHALL NOT require a new mole issue.

#### Scenario: pipeline release does not explicitly add gitignored FRG

- **WHEN** `.agent-pipeline/frg/` is listed in the artifact ignore contract and the repository `.gitignore`
- **AND** `pipeline release` stages the release commit after an FRG pass
- **THEN** the `git add` argv SHALL NOT contain `.agent-pipeline/frg` or any path under it
- **AND** the command SHALL NOT use `git add -f` on that tree

#### Scenario: Explicit add of an ignored contract path is the defect this test bites

- **WHEN** a unit test inspects the `git add` pathspec used by `pipeline release` after an FRG pass
- **AND** that pathspec includes `.agent-pipeline/frg` while `.agent-pipeline/frg/` is gitignored
- **THEN** the test SHALL fail
