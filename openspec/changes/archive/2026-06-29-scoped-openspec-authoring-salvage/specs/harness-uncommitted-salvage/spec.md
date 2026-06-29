## ADDED Requirements

### Requirement: Salvage staging scope SHALL be parameterizable and default to unscoped

The salvage path SHALL accept an optional staging-scope git pathspec (across
`salvageUncommittedWork`, `trySalvageUncommittedWork`, and the `salvageIfNoNewCommit` call helper).
When the scope is omitted, the salvage SHALL behave exactly as today: `git status --porcelain` SHALL be
evaluated against the whole worktree and staging SHALL use `git add -A -- :(exclude)node_modules`.
The implement, fix-round, and test-fix salvage call sites SHALL pass no scope and SHALL therefore be
unchanged.

#### Scenario: Implement-stage salvage with no scope is unchanged

- **WHEN** the implement harness exits with `headAfter === headBefore` and the worktree is dirty
- **AND** the pipeline salvages without a scope
- **THEN** the salvage SHALL stage all changes via `git add -A -- :(exclude)node_modules`
- **AND** a modified file outside `openspec/` (for example `core/scripts/foo.ts`) SHALL be included
  in the salvage commit

#### Scenario: Fix-round and test-fix salvage call sites pass no scope

- **WHEN** a fix-round or test-fix harness leaves uncommitted work and the pipeline salvages it
- **THEN** the salvage SHALL use the unscoped default staging (`git add -A -- :(exclude)node_modules`)
- **AND** the existing fix/test-fix salvage behavior SHALL be unchanged

### Requirement: OpenSpec authoring salvage SHALL stage only `openspec/` paths

The OpenSpec authoring salvage call site SHALL pass the scope `openspec/`. When the OpenSpec
authoring harness exits with no new commit and the pipeline salvages its work, the salvage SHALL
stage and commit only changes under `openspec/`; tracked-file modifications outside `openspec/` (for
example `tasks/todo.md` planning notes) SHALL NOT be staged or committed. This aligns the salvage
staging scope with the authoring guard's allow-pattern (`/^openspec\//`) so that a salvaged authoring
commit satisfies the guard instead of tripping it with "OpenSpec authoring step committed files
outside `openspec/`". Modifications outside `openspec/` SHALL be left uncommitted in the worktree and
SHALL NOT be discarded (no `git restore`).

#### Scenario: Authoring harness leaves an openspec change and a modified tasks/todo.md uncommitted

- **WHEN** the OpenSpec authoring harness exits with `headAfter === headBefore`
- **AND** the worktree contains an uncommitted `openspec/changes/<id>/` change AND a modified
  `tasks/todo.md`
- **THEN** the salvage SHALL stage only paths under `openspec/` (a `git add` whose pathspec
  restricts to `openspec/`, retaining `:(exclude)node_modules`)
- **AND** the salvage commit SHALL contain only `openspec/` files
- **AND** the modified `tasks/todo.md` SHALL remain uncommitted in the worktree, not discarded

#### Scenario: Salvaged authoring commit passes the path-constraint guard

- **WHEN** the pipeline creates an OpenSpec authoring salvage commit
- **THEN** every file in the salvage commit's diff SHALL match `/^openspec\//`
- **AND** `verifyHarnessCommits` with the authoring `allowPattern` SHALL return ok
- **AND** the stage SHALL advance to plan-review rather than block

### Requirement: Scoped salvage dirtiness check SHALL honor the scope

When a salvage is given a staging scope, it SHALL evaluate worktree dirtiness within that scope:
`git status --porcelain` SHALL be restricted to the scope pathspec so that changes lying entirely
outside the scope are treated as "nothing to salvage". A scoped salvage whose only uncommitted
changes are outside the scope SHALL create no commit and SHALL return `{ salvaged: false }`, letting
the caller fall through to its existing block path rather than committing the out-of-scope files or
producing a commit that trips the path-constraint guard.

#### Scenario: Worktree dirty only outside the scope — no salvage commit, existing block message

- **WHEN** the OpenSpec authoring harness exits with `headAfter === headBefore`
- **AND** the only uncommitted change is `tasks/todo.md` and no `openspec/changes/<id>/` directory
  exists on disk
- **THEN** the scoped salvage SHALL detect no in-scope changes and create no commit (`gitAddAll` and
  `gitCommit` SHALL NOT be called)
- **AND** the planning stage SHALL block with its existing "produced no change under
  `openspec/changes/`" message
- **AND** SHALL NOT block with "OpenSpec authoring step committed files outside `openspec/`"

### Requirement: Scoped salvage SHALL have a biting regression test

The test suite SHALL include a unit test in which the salvage path is given the `openspec/` scope and
a worktree mock that contains both an `openspec/` change and a tracked-file modification outside
`openspec/`; the test SHALL assert the `gitAddAll` args restrict staging to `openspec/` and that the
out-of-scope file is absent from the resulting salvage commit. The test SHALL bite: with the scope
removed, the same worktree SHALL produce a salvage commit whose diff includes the out-of-scope file
and fails the authoring path-constraint guard.

#### Scenario: Regression test proves the out-of-scope file is excluded under scope and included without it

- **WHEN** the fake `gitStatus` reports an `openspec/changes/x/proposal.md` change alongside a
  modified `tasks/todo.md`
- **AND** the salvage runs with the `openspec/` scope
- **THEN** the test SHALL assert `gitAddAll` is called with a pathspec restricting to `openspec/`
- **AND** SHALL assert the salvage commit diff (as seen by the authoring guard) contains no path
  outside `openspec/`
- **AND** SHALL assert that running the same worktree without the scope includes `tasks/todo.md` and
  fails `verifyHarnessCommits` with the authoring `allowPattern`
