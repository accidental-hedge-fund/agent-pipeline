## ADDED Requirements

### Requirement: BlockerKind includes review-prompt-too-large with a non-same-payload recipe

The `BlockerKind` closed set SHALL include the member `review-prompt-too-large`, used when a review round refuses to spawn because the fully assembled review prompt exceeds the effective reviewer input character ceiling.

`BLOCKER_RECIPES` SHALL map `review-prompt-too-large` to a non-empty recipe that:

- states that the assembled review prompt exceeded the reviewer input ceiling;
- directs the operator that re-running the pipeline **without** reducing the assembled prompt or changing the reviewer/ceiling configuration will fail the same way;
- directs a path that requires a material change (payload, reviewer assignment, or follow-up that shrinks assembly) before a successful re-run;
- SHALL NOT advise that a transient timeout can be “unblocked and re-run as-is”;
- SHALL NOT present generic label-clear-only `--unblock` as sufficient recovery for this class.

Exhaustiveness and recipe snapshot/string-assertion coverage that already pins every `BlockerKind` SHALL include this member so an absent or emptied recipe fails the test suite.

#### Scenario: review-prompt-too-large is a closed BlockerKind member

- **WHEN** the `BLOCKER_KINDS` enum is inspected
- **THEN** it SHALL contain `review-prompt-too-large`
- **AND** `BLOCKER_RECIPES` SHALL contain a non-empty string for that kind

#### Scenario: Recipe refuses same-payload re-run guidance

- **WHEN** `setBlocked` is called with kind `review-prompt-too-large`
- **THEN** the posted “### How to unblock” section SHALL state that re-running without reducing the prompt or changing the reviewer/ceiling will fail again
- **AND** the recipe text SHALL NOT contain the phrase “re-run as-is”
- **AND** the recipe text SHALL NOT claim a transient timeout can be cleared by unblock alone

#### Scenario: Snapshot exhaustiveness covers the new kind

- **WHEN** the blocked-recipe snapshot or exhaustiveness tests run
- **THEN** they SHALL assert a non-empty `BLOCKER_RECIPES` entry for `review-prompt-too-large`
- **AND** a missing or empty entry SHALL fail the test suite
