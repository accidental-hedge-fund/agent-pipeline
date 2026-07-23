## ADDED Requirements

### Requirement: Salvage SHALL exclude pipeline-internal marker files from salvageable work

The salvage path SHALL NOT treat a pipeline-internal marker file — a transient host-local
coordination file the engine writes into the worktree, such as `.pipeline-rebase-attempted`
(`REBASE_MARKER_FILE`, written by the pre-merge auto-rebase) — as salvageable uncommitted
work. Both the dirtiness determination (`git status --porcelain`, unscoped and scoped) and
the staging step (`git add`) SHALL exclude such marker files, so that a salvage commit whose
only content is a pipeline-internal marker file is never produced. Genuine uncommitted work
that coexists with a marker SHALL still be salvaged, with the marker excluded from the
commit.

#### Scenario: Worktree dirty only with the rebase marker — treated as clean, no salvage commit

- **WHEN** a harness step exits with `headAfter === headBefore`
- **AND** the only dirty path in the worktree is `.pipeline-rebase-attempted`
- **THEN** the salvage dirtiness check SHALL treat the worktree as clean
- **AND** `salvageUncommittedWork` SHALL return `{ salvaged: false }` without calling
  `gitAddAll` or `gitCommit`
- **AND** the caller SHALL follow its existing block / auto-recover path as if no
  uncommitted changes were present
- **AND** no commit whose only content is `.pipeline-rebase-attempted` SHALL be produced

#### Scenario: Worktree dirty with the rebase marker alongside real changed work — marker excluded, real work salvaged

- **WHEN** a harness step exits with `headAfter === headBefore`
- **AND** the worktree contains both a real changed source file (for example
  `core/scripts/foo.ts`) and `.pipeline-rebase-attempted`
- **THEN** the salvage SHALL create a commit containing the real changed source file
- **AND** the salvage `git add` args SHALL include a depth-agnostic exclusion pathspec for
  the marker (`:(exclude,glob)**/.pipeline-rebase-attempted`)
- **AND** the salvage commit SHALL NOT include `.pipeline-rebase-attempted`

#### Scenario: Scoped (openspec/) salvage also excludes the marker

- **WHEN** the OpenSpec authoring salvage runs with the `openspec/` scope
- **AND** the worktree contains an `openspec/changes/<id>/` change and
  `.pipeline-rebase-attempted`
- **THEN** the salvage SHALL stage only paths under `openspec/`
- **AND** SHALL exclude `.pipeline-rebase-attempted`
- **AND** the salvage commit SHALL contain only `openspec/` files

### Requirement: Pipeline-internal marker filename SHALL be single-sourced

The set of pipeline-internal marker filenames the salvage path excludes SHALL be defined in
a single canonical, exported constant (currently `[".pipeline-rebase-attempted"]`), and the
pre-merge marker writer's `REBASE_MARKER_FILE` SHALL refer to that same canonical source, so
the exclusion and the writer cannot drift. Because the runtime performs no type-check, a
runtime test SHALL assert the alignment.

#### Scenario: REBASE_MARKER_FILE matches the canonical marker list

- **WHEN** the test suite runs
- **THEN** a unit test SHALL assert that `REBASE_MARKER_FILE` equals the canonical
  pipeline-internal marker constant used by the salvage exclusion
- **AND** the assertion SHALL fail if either the writer's filename or the salvage exclusion
  list is changed without the other

### Requirement: Marker-exclusion salvage SHALL have a biting regression test

The test suite SHALL include a unit test in which the salvage path is given a worktree mock
whose only dirty path is `.pipeline-rebase-attempted`; the test SHALL assert that no salvage
commit is produced (`gitAddAll` and `gitCommit` are not called and the result is
`{ salvaged: false }`). The test SHALL bite: with the marker exclusion removed from the
dirtiness check, the same worktree SHALL produce a salvage commit whose only content is the
marker.

#### Scenario: Regression test proves the marker-only worktree yields no commit and bites

- **WHEN** the fake `gitStatus` reports `.pipeline-rebase-attempted` as the only dirty path
- **AND** the salvage runs with the marker exclusion in place
- **THEN** the test SHALL assert `salvageUncommittedWork` returns `{ salvaged: false }` and
  neither `gitAddAll` nor `gitCommit` is called
- **AND** SHALL assert that removing the marker exclusion from the dirtiness check makes the
  same worktree produce a salvage commit that stages the marker
