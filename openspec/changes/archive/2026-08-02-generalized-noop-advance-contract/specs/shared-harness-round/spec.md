## ADDED Requirements

### Requirement: Shared harness-round clean no-new-commit path SHALL support stage goal-satisfaction callbacks

The shared harness-round helper SHALL allow a migrated consumer to supply a goal-satisfaction callback (or equivalent hook into the `noop-advance-contract` evaluation) for the confirmed clean no-new-commit path after salvage finds nothing. When the callback/evaluation returns **advance**, the helper or caller SHALL expose that outcome so the stage can advance with attested evidence without inventing an empty commit. When it returns **escalate** or is omitted, the helper SHALL preserve the stage’s existing clean no-commit block or stage-specific noop-clean outcome. Dirty salvage success and non-empty commit ranges SHALL remain unchanged and SHALL NOT be forced through goal-satisfaction short-circuit.

#### Scenario: Consumer supplies satisfied goal on clean no-new-commit

- **WHEN** a migrated consumer’s harness exits with no new commit and a clean worktree
- **AND** the consumer-supplied goal check reports satisfied via the shared contract
- **THEN** the round outcome SHALL be advance-eligible without inventing a commit
- **AND** SHALL NOT force the generic clean no-commit hard-block path

#### Scenario: Consumer omits goal check — existing stage outcome preserved

- **WHEN** a migrated consumer does not supply a goal-satisfaction hook
- **AND** the harness exits with no new commit and a clean worktree
- **THEN** the helper SHALL follow the stage’s pre-existing clean no-commit / noop-clean / block product rule
- **AND** SHALL NOT invent a default “always advance” behavior

#### Scenario: Planning implement deliverable-present uses the hook

- **WHEN** the planning implement consumer ends with no new implementer commit, clean tree, and declared deliverable already present at HEAD
- **THEN** the consumer SHALL use the shared goal-satisfaction path (implement-deliverable-present)
- **AND** SHALL advance without requiring an empty implementer commit when checks and gates pass
