## ADDED Requirements

### Requirement: Fix-round no-actionable-work advances SHALL use the shared noop-advance contract

The fix stage’s behavior-preserving no-op advances — empty effective blocking set after live override subtract (skip harness), and post-harness no-new-commit when every invoked blocking finding is covered by a valid does-not-reproduce declaration — SHALL be decided through the shared `noop-advance-contract` evaluation (or a thin stage adapter that calls it) rather than a private full copy of the “no new commit → block or advance” skeleton. Observable outcomes SHALL remain those already required by this capability: advance `fix-1` → `review-2` and `fix-2` → `pre-merge` without `blockerKind: "no-commits"` when no actionable work remains; partial coverage and invalid declarations SHALL continue to fail closed. Attested evidence for post-harness advances SHALL satisfy the shared contract’s evidence requirement (stage, HEAD SHA, rationale class).

#### Scenario: All-declared non-reproducing path routes through shared evaluation

- **WHEN** a fix round produces no new commit, salvage finds nothing, and every invoked blocking finding has a valid does-not-reproduce declaration at current HEAD
- **THEN** the fix stage SHALL obtain an **advance** decision via the shared noop-advance evaluation (directly or via adapter)
- **AND** SHALL advance to the round’s next stage without `blockerKind: "no-commits"`
- **AND** SHALL record attested goal-satisfaction evidence including the HEAD SHA

#### Scenario: Partial declaration coverage still fails closed

- **WHEN** a fix round produces no new commit and at least one invoked blocking finding lacks a valid does-not-reproduce declaration and is not otherwise dispositioned
- **THEN** the shared evaluation (or adapter) SHALL yield **escalate**
- **AND** the fix stage SHALL block with `blockerKind: "no-commits"` as today

#### Scenario: Override-empty pre-harness skip remains advance without harness

- **WHEN** a fix round begins and every triggering blocking finding is covered by an active trusted override
- **THEN** the fix stage SHALL advance without invoking the harness and without `no-commits`
- **AND** that outcome SHALL be expressible as stage goal satisfaction under the shared contract (pre-harness or equivalent phase)
