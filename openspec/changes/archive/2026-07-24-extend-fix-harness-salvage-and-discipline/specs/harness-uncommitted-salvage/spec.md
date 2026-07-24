## ADDED Requirements

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
