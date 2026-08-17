## ADDED Requirements

### Requirement: A fix-no-actionable-work advance SHALL skip a behind-remote push
When the fix stage has a `fix-no-actionable-work` advance decision (empty effective blocking set, valid does-not-reproduce coverage, or external-commit HEAD already past the reviewed SHA) and local HEAD is an ancestor of `origin/<branch>` (or the open-PR head), the stage SHALL skip the push and advance to the round’s next stage. The stage SHALL NOT push the older local tip. The stage SHALL NOT force-push. When local HEAD is not an ancestor and the stage still has unique commits to deliver, the existing shared-wrapper push path SHALL apply.

#### Scenario: Ancestor tip after noop skips push and advances
- **WHEN** a fix round returns `fix-no-actionable-work`
- **AND** local HEAD is an ancestor of `origin/<branch>` (as in #1038: local `8ea2d1a`, remote `bb208ba`)
- **THEN** the fix stage SHALL NOT invoke push of that older tip
- **AND** it SHALL advance `fix-1` to `review-2` or `fix-2` to `pre-merge`
- **AND** it SHALL NOT block with `blockerKind: "push-failed"`

#### Scenario: Unique local commits still push through the wrapper
- **WHEN** a fix round produced new local commits that are not ancestors of `origin/<branch>`
- **THEN** the stage SHALL push through the shared currency-check wrapper
- **AND** a non-fast-forward reject SHALL follow `push-failure-classification` (workflow-state, never force-push)

#### Scenario: Equal HEAD and verified remote skip push
- **WHEN** a fix round returns `fix-no-actionable-work`
- **AND** local HEAD equals the verified open-PR or remote head
- **THEN** the fix stage SHALL skip the push
- **AND** it SHALL advance to the round’s next stage

#### Scenario: Unverified remote head does not skip or reset
- **WHEN** a fix round returns `fix-no-actionable-work`
- **AND** the open-PR head and `origin/<branch>` cannot be verified
- **THEN** the stage SHALL NOT skip the push as if HEAD were current
- **AND** it SHALL NOT reset or rematerialize the worktree
- **AND** it SHALL fall through to the shared currency-check wrapper
