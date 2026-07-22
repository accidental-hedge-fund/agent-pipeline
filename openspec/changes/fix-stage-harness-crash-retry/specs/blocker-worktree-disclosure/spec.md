# blocker-worktree-disclosure

## ADDED Requirements

### Requirement: Fix-stage blocker comments SHALL disclose recoverable worktree state

A fix-stage blocker comment whose kind is `harness-failure` or `no-commits` SHALL include a
worktree-state section derived from `git status --short` in the run's worktree: the counts of
staged, unstaged, and untracked entries, plus a bounded list of the affected paths. The section
makes it immediately visible to an operator that recoverable work exists, rather than requiring
them to guess and open the worktree.

#### Scenario: Staged-but-uncommitted work is surfaced in the blocker

- **WHEN** a fix-2 round blocks with `no-commits` and the worktree contains 4 staged files
- **THEN** the blocker comment SHALL include a worktree-state section reporting 4 staged entries
- **AND** SHALL list those paths (bounded by the truncation limit)

#### Scenario: Harness-failure blocker surfaces the crashed attempt's diff

- **WHEN** a fix round blocks with `harness-failure` after exhausted retries and the worktree holds
  uncommitted changes
- **THEN** the blocker comment SHALL include the worktree-state section describing those changes

#### Scenario: Clean worktree omits the section

- **WHEN** a fix-stage blocker is posted and `git status --short` returns empty output
- **THEN** the blocker comment SHALL omit the worktree-state section entirely

#### Scenario: Long file lists are truncated deterministically

- **WHEN** the worktree contains more changed entries than the display limit
- **THEN** the section SHALL list at most the limit and SHALL state how many further entries were
  omitted

#### Scenario: Status read failure degrades gracefully

- **WHEN** reading `git status --short` fails or the worktree is missing
- **THEN** the blocker comment SHALL still be posted with its existing content and SHALL omit the
  worktree-state section
- **AND** the stage outcome SHALL be unchanged

### Requirement: The worktree-state summary SHALL be rendered by a pure, tested function

The summary SHALL be produced by an exported pure function that takes `git status --short` output
and returns the rendered section (or nothing when clean), so it is unit-testable without git.

#### Scenario: Unit test renders a summary from porcelain text

- **WHEN** the function is given short-status text containing staged, unstaged, and untracked
  entries
- **THEN** it SHALL return a section whose counts match those entries
- **AND** it SHALL return no section for empty input
