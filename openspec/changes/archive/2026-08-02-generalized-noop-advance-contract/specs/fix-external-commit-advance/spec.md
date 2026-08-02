## ADDED Requirements

### Requirement: External-commit no-new-commit advance SHALL use the shared noop-advance contract

When a fix round’s harness produces no new commit and salvage finds nothing, the decision to advance because HEAD is past the reviewed SHA (external commit already applied), or to fall through to the existing `no-commits` block when HEAD equals the reviewed SHA and no other sanctioned carve-out applies, SHALL be obtained through the shared `noop-advance-contract` evaluation (or a thin adapter that calls it with a fix external-commit goal check). Behavior SHALL remain fail-closed when no reviewed SHA is available and when HEAD equals the reviewed SHA without override-empty or does-not-reproduce coverage. Existing unit tests for advance-on-ahead-SHA and block-on-equal/missing-SHA SHALL continue to pass and SHALL fail if the shared path is removed while restoring only a private hard block.

#### Scenario: HEAD ahead of reviewed SHA advances via shared evaluation

- **WHEN** a fix round ends with `headBefore === headAfter`, salvage empty, and HEAD differs from the trusted reviewed SHA
- **THEN** the shared evaluation (or adapter) SHALL return **advance** under the fix external-commit / no-actionable-work goal class
- **AND** the fix stage SHALL advance to the round’s next stage without `blockerKind: "no-commits"`

#### Scenario: HEAD equals reviewed SHA without carve-out escalates via shared evaluation

- **WHEN** a fix round ends with no new commit, salvage empty, HEAD equals the reviewed SHA, and no override-empty or valid full does-not-reproduce coverage applies
- **THEN** the shared evaluation (or adapter) SHALL return **escalate**
- **AND** the fix stage SHALL block with `blockerKind: "no-commits"` as today
