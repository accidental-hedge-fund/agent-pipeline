## MODIFIED Requirements

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
