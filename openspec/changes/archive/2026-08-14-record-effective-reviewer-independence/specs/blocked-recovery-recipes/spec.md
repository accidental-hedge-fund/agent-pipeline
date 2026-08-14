## ADDED Requirements

### Requirement: BlockerKind SHALL include review independent-quorum and no-usable-reviewers classes

The `BlockerKind` enum SHALL include distinct members for independent-quorum failure and no-usable-reviewers failure on the review seam (stable string ids such as `review-independent-quorum-unmet` and `review-no-usable-reviewers`). Each new kind SHALL have a non-empty `BLOCKER_RECIPES` entry. The quorum-unmet recipe SHALL direct the operator to restore independent coverage (add a distinct provider/model-family reviewer, fix self-review-only degradation, or adjust config with audit) and re-run after clearing the block; it SHALL NOT instruct silent approve. The no-usable-reviewers recipe SHALL direct the operator to restore reviewer harness availability (CLI install/auth/capacity), then clear the block and re-run; it SHALL NOT classify the failure as product-judgment needs-human by default.

#### Scenario: quorum unmet kind has a recipe

- **WHEN** `setBlocked` is called with the independent-quorum-unmet kind
- **THEN** the blocked comment "### How to unblock" section SHALL contain the quorum recipe text
- **AND** SHALL mention independent coverage or quorum
- **AND** SHALL NOT instruct the operator merely to approve without restoring coverage

#### Scenario: no usable reviewers kind has a recipe

- **WHEN** `setBlocked` is called with the no-usable-reviewers kind
- **THEN** the blocked comment "### How to unblock" section SHALL contain harness/availability recovery steps
- **AND** SHALL NOT default to the product-judgment override recipe alone

#### Scenario: new kinds appear in recipe coverage tests

- **WHEN** the BlockerKind recipe snapshot or exhaustiveness tests run
- **THEN** they SHALL include the new quorum and no-usable kinds
- **AND** SHALL fail if either recipe string is empty or missing
