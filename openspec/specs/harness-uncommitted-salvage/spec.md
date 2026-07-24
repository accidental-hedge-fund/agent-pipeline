# harness-uncommitted-salvage Specification

## Purpose
TBD - created by archiving change recovery-salvage-uncommitted-harness-work. Update Purpose after archive.
## Requirements
### Requirement: Pipeline SHALL salvage uncommitted harness work before blocking on no-commit

When a harness step (implement, fix round, or test-fix) exits and the pipeline detects that no new commit was produced in the harness range but the worktree contains uncommitted changes, the pipeline SHALL stage all changes — excluding `node_modules` entries at any nesting depth — and create a salvage commit in the worktree before proceeding, rather than blocking with "No commits found in the range". The staging command SHALL use a depth-agnostic node_modules exclusion (`:(exclude,glob)**/node_modules` and `:(exclude,glob)**/node_modules/**`), so a nested install such as `apps/web/node_modules/` in a monorepo is excluded and the add does not fail on ignored nested paths.

#### Scenario: Dirty worktree after implement harness — salvage commit created and pipeline advances

- **WHEN** the implement harness exits and `headBefore === headAfter`
- **AND** `git status --porcelain` in the worktree returns non-empty output
- **THEN** the pipeline SHALL run `git add -A` with the depth-agnostic node_modules exclusion followed by `git commit` with a salvage message in the worktree
- **AND** the commit message SHALL begin with `salvage: stage harness work (#<issueNumber>)`
- **AND** the commit message SHALL include `Issue: #<issueNumber>` and `Pipeline-Run: <pipelineRunId>` trailers
- **AND** the pipeline SHALL proceed to the test gate as if the harness had committed

#### Scenario: Dirty worktree after fix round — salvage commit created and pipeline advances

- **WHEN** a fix-round harness (round 1 or 2) exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit using `git add -A` with the depth-agnostic node_modules exclusion, with the same subject prefix and trailers
- **AND** SHALL proceed to the downstream verification steps (test gate, format check) as normal

#### Scenario: Dirty worktree after test-fix harness — salvage commit created

- **WHEN** a test-fix harness exits and no new commit is detected
- **AND** the worktree contains uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit using `git add -A` with the depth-agnostic node_modules exclusion and proceed to re-run the test command

#### Scenario: Dirty worktree in a monorepo with a nested node_modules install — salvage succeeds

- **WHEN** a harness exits with `headAfter === headBefore` and the worktree is dirty
- **AND** the dirty worktree contains both real changed source files (for example `apps/web/src/foo.ts`) and a nested ignored install at `apps/web/node_modules/.pnpm/...`
- **THEN** the salvage `git add` SHALL exclude the nested `apps/web/node_modules` path and SHALL NOT exit non-zero because of the ignored nested paths
- **AND** the salvage commit SHALL include the real changed source files
- **AND** the salvage commit SHALL NOT include any path whose components include `node_modules` at any depth
- **AND** the pipeline SHALL advance rather than block with "produced no commits"

#### Scenario: Dirty worktree contains only node_modules changes — treated as clean

- **WHEN** a harness exits and no new commit was produced
- **AND** `git status --porcelain` reports changes only under `node_modules` (at any depth)
- **THEN** after the excluded staging, the worktree SHALL be effectively clean
- **AND** the pipeline SHALL follow the existing block / auto-recover path as if no uncommitted changes were present

#### Scenario: Clean worktree after harness — existing block path unchanged

- **WHEN** a harness step exits and no new commit was produced
- **AND** `git status --porcelain` in the worktree returns empty output (clean worktree)
- **THEN** the pipeline SHALL NOT attempt salvage
- **AND** SHALL follow the existing block / auto-recover path without modification

### Requirement: Salvage commit SHALL carry traceability trailers

Every commit created by the salvage path SHALL include the `Issue:` and `Pipeline-Run:` trailers required by the `commit-traceability-trailers` spec.

#### Scenario: Salvage commit has Issue and Pipeline-Run trailers

- **WHEN** the pipeline creates a salvage commit for issue N during a run with ID R
- **THEN** the commit message SHALL end with a blank line followed by `Issue: #N` and `Pipeline-Run: R` on separate lines

---

### Requirement: Salvage SHALL NOT bypass the test gate or any downstream verification

A salvaged commit advances the pipeline to the same post-commit verification path as a normally-committed harness result. A salvage commit that does not pass the test gate SHALL block the pipeline exactly as a normal failing commit would.

#### Scenario: Salvaged commit fails the test gate — pipeline blocks

- **WHEN** the pipeline creates a salvage commit and runs the test gate
- **AND** the test command exits non-zero
- **THEN** the pipeline SHALL block at the test gate with the test failure reason
- **AND** SHALL NOT advance to the next stage

#### Scenario: Salvaged commit passes the test gate — pipeline advances normally

- **WHEN** the pipeline creates a salvage commit and runs the test gate
- **AND** the test command exits 0
- **THEN** the pipeline SHALL advance to the next stage (e.g., PR creation or review) as normal

---

### Requirement: Salvage behavior SHALL be injectable for unit testing

The `salvageUncommittedWork` function SHALL accept a `SalvageDeps` parameter with injectable `gitStatus`, `gitAddAll`, and `gitCommit` seams. Unit tests SHALL use fake implementations of these seams and SHALL NOT invoke real git subprocesses.

#### Scenario: Unit test exercises dirty-worktree salvage path

- **WHEN** the fake `gitStatus` returns non-empty porcelain output
- **THEN** the test SHALL verify that fake `gitAddAll` and `gitCommit` are called with the correct arguments and message format

#### Scenario: Unit test exercises clean-worktree no-op path

- **WHEN** the fake `gitStatus` returns empty porcelain output
- **THEN** the test SHALL verify that neither `gitAddAll` nor `gitCommit` is called

### Requirement: Salvage staging scope SHALL be parameterizable and default to unscoped

The salvage path SHALL accept an optional staging-scope git pathspec (across
`salvageUncommittedWork`, `trySalvageUncommittedWork`, and the `salvageIfNoNewCommit` call helper).
When the scope is omitted, the salvage SHALL evaluate `git status --porcelain` against the whole
worktree and staging SHALL use `git add -A` with the depth-agnostic node_modules exclusion
(`:(exclude,glob)**/node_modules` and `:(exclude,glob)**/node_modules/**`). The implement,
fix-round, and test-fix salvage call sites SHALL pass no scope and SHALL therefore continue to stage
the whole worktree minus `node_modules` at any depth.

#### Scenario: Implement-stage salvage with no scope stages the whole worktree minus node_modules

- **WHEN** the implement harness exits with `headAfter === headBefore` and the worktree is dirty
- **AND** the pipeline salvages without a scope
- **THEN** the salvage SHALL stage all changes via `git add -A` with the depth-agnostic node_modules exclusion
- **AND** a modified file outside `openspec/` (for example `core/scripts/foo.ts`) SHALL be included
  in the salvage commit
- **AND** no `node_modules` path at any depth SHALL be included

#### Scenario: Fix-round and test-fix salvage call sites pass no scope

- **WHEN** a fix-round or test-fix harness leaves uncommitted work and the pipeline salvages it
- **THEN** the salvage SHALL use the unscoped default staging (`git add -A` with the depth-agnostic node_modules exclusion)
- **AND** the existing fix/test-fix salvage behavior SHALL be unchanged apart from the exclusion now matching nested `node_modules`

### Requirement: OpenSpec authoring salvage SHALL stage only `openspec/` paths

The OpenSpec authoring salvage call site SHALL pass the scope `openspec/`. When the OpenSpec
authoring harness exits with no new commit and the pipeline salvages its work, the salvage SHALL
stage and commit only changes under `openspec/`; tracked-file modifications outside `openspec/` (for
example `tasks/todo.md` planning notes) SHALL NOT be staged or committed. This aligns the salvage
staging scope with the authoring guard's allow-pattern (`/^openspec\//`) so that a salvaged authoring
commit satisfies the guard instead of tripping it with "OpenSpec authoring step committed files
outside `openspec/`". Modifications outside `openspec/` SHALL be left uncommitted in the worktree and
SHALL NOT be discarded (no `git restore`). The scoped staging SHALL retain the depth-agnostic
node_modules exclusion (`:(exclude,glob)**/node_modules` and `:(exclude,glob)**/node_modules/**`).

#### Scenario: Authoring harness leaves an openspec change and a modified tasks/todo.md uncommitted

- **WHEN** the OpenSpec authoring harness exits with `headAfter === headBefore`
- **AND** the worktree contains an uncommitted `openspec/changes/<id>/` change AND a modified
  `tasks/todo.md`
- **THEN** the salvage SHALL stage only paths under `openspec/` (a `git add` whose pathspec
  restricts to `openspec/`, retaining the depth-agnostic node_modules exclusion)
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

### Requirement: A failed salvage attempt SHALL disclose its failure reason in the no-commit blocker comment

When the pipeline attempts to salvage uncommitted harness work and the salvage's git operation fails (for example the staging add exits non-zero), the pipeline SHALL capture the failure reason and SHALL include it in the subsequent no-commit blocker comment, so an operator can see that recoverable work may exist and why nothing was salvaged without reading `terminal.log`. When no salvage was attempted, when the worktree was genuinely clean, or when the salvage succeeded, the blocker comment SHALL be unchanged.

#### Scenario: Salvage add fails on ignored nested paths — reason surfaced in the blocker

- **WHEN** a salvage attempt is made for a dirty worktree and the salvage git operation throws (for example git refuses ignored nested `node_modules` paths)
- **AND** the pipeline consequently blocks with a no-commit blocker
- **THEN** the blocker comment SHALL include the captured salvage failure reason
- **AND** SHALL NOT report only a bare "produced no commits" with no salvage detail

#### Scenario: Clean worktree — blocker comment unchanged

- **WHEN** a harness step exits with no new commit and a clean worktree, so no salvage is attempted
- **THEN** the no-commit blocker comment SHALL be unchanged (no salvage-failure section)

#### Scenario: Salvage failure disclosure is unit-tested without git

- **WHEN** a fake salvage helper reports a failure reason for a dirty worktree
- **THEN** a unit test SHALL assert the failure reason is threaded into the block reason passed to the blocker sink
- **AND** SHALL assert the clean/no-attempt case passes the unchanged block reason

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

### Requirement: Pre-merge bounded auto-fix SHALL salvage uncommitted work instead of discarding it

The pre-merge bounded auto-fix path SHALL, when its fix harness exits (whether it reported success,
crashed, or timed out) having produced **no new commit** (`headAfter === headBefore`) while the
worktree contains genuine uncommitted changes, salvage that uncommitted work into a commit rather
than running `git reset --hard` / `git clean -fd` and returning `error`. The salvaged commit SHALL
then be handled exactly like a harness-authored auto-fix commit: it SHALL be amended to carry the
canonical `PRE_MERGE_AUTOFIX_PREFIX` subject (so the one-attempt bound still detects it), it SHALL
include the `Issue:`/`Pipeline-Run:` traceability trailers, it SHALL be pushed to the PR head, and it
SHALL be subjected to the pre-merge delta review-SHA gate (re-review). Salvage here SHALL reuse the
shared salvage helper (staging the whole worktree minus `node_modules` and pipeline-internal marker
files) and SHALL NOT bypass re-review. When the worktree is genuinely clean (nothing to salvage), the
existing fail-closed rollback (`git reset --hard` + `git clean -fd`) and `error` return SHALL be
unchanged.

#### Scenario: Pre-merge auto-fix harness leaves uncommitted work — salvaged, pushed, re-reviewed

- **WHEN** the pre-merge bounded auto-fix harness exits with `headAfter === headBefore`
- **AND** `git status --porcelain` in the worktree reports genuine uncommitted changes (not only
  `node_modules` or a pipeline-internal marker)
- **THEN** the pipeline SHALL create a salvage commit from the uncommitted work instead of running
  `git reset --hard` / `git clean -fd`
- **AND** the resulting commit SHALL carry the `PRE_MERGE_AUTOFIX_PREFIX` subject and the
  `Issue:`/`Pipeline-Run:` trailers
- **AND** the pipeline SHALL push it to the PR head and the pre-merge review-SHA gate SHALL re-review
  the new head rather than treating it as already-approved

#### Scenario: Pre-merge auto-fix harness times out with a dirty worktree — work salvaged, not discarded

- **WHEN** the pre-merge bounded auto-fix harness invocation returns `!result.success` (timeout or
  crash)
- **AND** the worktree contains genuine uncommitted changes
- **THEN** the pipeline SHALL attempt salvage before any `git reset --hard` rollback
- **AND** SHALL NOT discard the uncommitted work when salvage succeeds

#### Scenario: Pre-merge auto-fix worktree is clean — existing fail-closed rollback unchanged

- **WHEN** the pre-merge bounded auto-fix harness exits with no new commit
- **AND** `git status --porcelain` reports the worktree is clean (nothing salvageable)
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** SHALL follow the existing rollback (`git reset --hard <headBefore>` + `git clean -fd`) and
  return `error` as today

#### Scenario: Salvaged pre-merge fix respects the one-attempt bound

- **WHEN** a pre-merge auto-fix salvage produces a commit carrying `PRE_MERGE_AUTOFIX_PREFIX`
- **THEN** the one-attempt bound SHALL detect that commit by subject prefix
- **AND** the pipeline SHALL NOT launch a second bounded auto-fix attempt for the same finding round

### Requirement: Implement stage SHALL salvage uncommitted work on the harness failure/timeout path

The implement stage SHALL attempt to salvage uncommitted harness work on the harness
failure/timeout path (`!result.success`) before blocking, mirroring the fix stage's crash-retry
salvage (#486). When the implement harness crashes or times out and leaves genuine uncommitted work
in the worktree, the pipeline SHALL salvage it into a commit and proceed to the normal downstream
verification (commit checks, test gate) instead of blocking with a harness-failure/no-commits block
that discards the work. When salvage is attempted and its git operation fails, the pipeline SHALL
disclose the failure reason in the block comment. When the worktree is clean (nothing salvageable),
the existing harness-failure block path SHALL be unchanged.

#### Scenario: Implement harness times out with uncommitted work — salvaged and advanced

- **WHEN** the implement harness invocation returns `!result.success` (timeout or crash)
- **AND** the worktree contains genuine uncommitted changes
- **THEN** the pipeline SHALL create a salvage commit before blocking
- **AND** SHALL proceed to the normal downstream verification (commit checks, test gate) as if the
  harness had committed

#### Scenario: Implement harness fails with a clean worktree — existing block unchanged

- **WHEN** the implement harness invocation returns `!result.success`
- **AND** `git status --porcelain` reports the worktree is clean
- **THEN** the pipeline SHALL NOT create a salvage commit
- **AND** SHALL follow the existing harness-failure block path without modification

#### Scenario: Implement-failure salvage fails — reason disclosed in the block comment

- **WHEN** the implement harness fails, the worktree is dirty, and the attempted salvage's git
  operation throws
- **AND** the pipeline consequently blocks
- **THEN** the block comment SHALL include the captured salvage failure reason
- **AND** SHALL NOT report only a bare harness-failure/no-commits message with no salvage detail

### Requirement: Extended salvage surfaces SHALL have biting regression tests

The test suite SHALL include unit tests, using the injectable salvage/git seams (no real git or
harness subprocesses), that bite for each newly-covered surface. A pre-merge auto-fix test SHALL
prove that a no-commit dirty worktree yields a salvaged, prefix-subjected, pushed commit (and fails
against the pre-change reset-and-discard behavior). An implement-failure test SHALL prove that a
crashed/timed-out harness with a dirty worktree is salvaged before blocking (and fails against the
pre-change block-without-salvage behavior).

#### Scenario: Pre-merge salvage regression test bites

- **WHEN** the pre-merge auto-fix runs with a fake harness that reports success/timeout, a fake git
  seam whose post-harness `status` is dirty, and `headAfter === headBefore`
- **THEN** the test SHALL assert a salvage commit is created, amended to `PRE_MERGE_AUTOFIX_PREFIX`,
  and pushed
- **AND** SHALL assert that with the salvage wiring removed the same inputs instead reset-and-discard
  and return `error`

#### Scenario: Implement-failure salvage regression test bites

- **WHEN** the implement stage runs with a fake harness returning `!result.success` and a dirty
  worktree
- **THEN** the test SHALL assert salvage is attempted before the block and, on success, the pipeline
  advances to the test gate
- **AND** SHALL assert that with the salvage wiring removed the same inputs block without salvaging

