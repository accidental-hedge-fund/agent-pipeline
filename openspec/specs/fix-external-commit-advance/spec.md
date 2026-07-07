# fix-external-commit-advance Specification

## Purpose
TBD - created by archiving change fix-advance-on-external-commit. Update Purpose after archive.
## Requirements
### Requirement: Fix stage SHALL advance when no new commit was produced but HEAD is past the reviewed SHA

The fix stage SHALL, when a fix round's harness produces no new commit (`headBefore === headAfter`) and the uncommitted-work salvage path finds nothing to commit, compare the worktree's current `HEAD` against the SHA the reviewer last reviewed (`review_sha`, resolved from the latest trusted review comment via the existing reviewed-SHA extraction). When a reviewed SHA is available and `HEAD` differs from it, the fix stage SHALL treat the fix as already applied externally and SHALL advance to the round's existing next stage rather than blocking: round 1 SHALL advance to `review-2` and round 2 SHALL advance to `pre-merge`.

#### Scenario: No new commit, salvage empty, HEAD ahead of reviewed SHA — round 1 advances to review-2

- **WHEN** a fix-round-1 harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** the latest trusted review comment carries a reviewed SHA that differs from the worktree `HEAD`
- **THEN** the fix stage SHALL advance from `fix-1` to `review-2`
- **AND** SHALL NOT block with the `no-commits` blocker
- **AND** the transition message SHALL state that the fix was already applied externally

#### Scenario: No new commit, salvage empty, HEAD ahead of reviewed SHA — round 2 advances to pre-merge

- **WHEN** a fix-round-2 harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** the latest trusted review comment carries a reviewed SHA that differs from the worktree `HEAD`
- **THEN** the fix stage SHALL advance from `fix-2` to `pre-merge`
- **AND** SHALL NOT block with the `no-commits` blocker

### Requirement: Fix stage SHALL block when no new commit was produced and HEAD equals the reviewed SHA

The fix stage SHALL block with the existing `no-commits` blocker and reason, unchanged
from prior behavior, when a fix round's harness produces no new commit, salvage finds
nothing, and the worktree `HEAD` equals the reviewed SHA — **except** when one of the
following no-op-advance carve-outs (see `fix-round-noop-advance`) applies: (1) the
triggering review's effective blocking set is empty after subtracting active overrides,
or (2) every invoked blocking finding is covered by a valid does-not-reproduce
declaration. When neither carve-out applies, the equal-SHA no-op SHALL block exactly as
before, because no work has been done since the reviewer last reviewed the branch.

#### Scenario: No new commit, salvage empty, HEAD equals reviewed SHA, no carve-out — blocks as before

- **WHEN** a fix round harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** the latest trusted review comment's reviewed SHA equals the worktree `HEAD`
- **AND** the effective blocking set is non-empty and at least one invoked blocking finding lacks a valid does-not-reproduce declaration
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`
- **AND** SHALL NOT advance to the next stage

#### Scenario: No new commit, salvage empty, HEAD equals reviewed SHA, all overridden — advances

- **WHEN** a fix round harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** the triggering review's effective blocking set is empty after subtracting active overrides
- **THEN** the fix stage SHALL advance to the round's next stage rather than block
- **AND** SHALL NOT block with `blockerKind: "no-commits"`

#### Scenario: No new commit, salvage empty, HEAD equals reviewed SHA, all findings non-reproducing — advances

- **WHEN** a fix round harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** every invoked blocking finding is covered by a valid does-not-reproduce declaration at the current HEAD
- **THEN** the fix stage SHALL advance to the round's next stage rather than block
- **AND** SHALL NOT block with `blockerKind: "no-commits"`

### Requirement: Fix stage SHALL fail closed when no reviewed SHA is extractable

The fix stage SHALL fail closed and block with the existing `no-commits` blocker rather than advance, when a fix round produces no new commit and salvage finds nothing and no reviewed SHA can be extracted from the trusted review comments (no review comment exists, or the latest one carries no SHA) — because it cannot prove the branch has advanced past a review.

#### Scenario: No new commit, salvage empty, no review comment — blocks (fail closed)

- **WHEN** a fix round harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** no trusted review comment with a reviewed SHA exists on the issue
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`
- **AND** SHALL NOT advance to the next stage

#### Scenario: No new commit, salvage empty, review comment without a SHA — blocks (fail closed)

- **WHEN** a fix round harness exits, `headBefore === headAfter`, and salvage finds nothing to commit
- **AND** the latest trusted review comment carries no reviewed SHA (legacy comment)
- **THEN** the fix stage SHALL block with `blockerKind: "no-commits"`
- **AND** SHALL NOT advance to the next stage

### Requirement: The advance-on-external-commit decision SHALL be unit-testable without real I/O

The reviewed-SHA comparison SHALL operate over the issue comments already fetched
by the fix stage and the worktree `HEAD` already read for the no-commit check, so
the decision is exercisable through the existing fix-stage test seams with no real
network, git, or subprocess calls. The regression suite SHALL cover the advance
path, the block-on-equal-SHA path, and the block-on-missing-SHA path, and SHALL
bite (fail against the pre-change fix stage).

#### Scenario: Regression tests cover all three paths and bite

- **WHEN** the fix-stage regression tests run
- **THEN** they SHALL assert the advance path returns an advanced outcome to the correct next stage without calling `setBlocked`
- **AND** SHALL assert the block-on-equal-SHA and block-on-missing-SHA paths return a `no-commits` blocked outcome
- **AND** SHALL fail when run against the fix stage without the advance-on-external-commit decision

