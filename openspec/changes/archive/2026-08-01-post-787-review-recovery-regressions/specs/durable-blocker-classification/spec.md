## MODIFIED Requirements

### Requirement: The engine SHALL classify every durable-run blocker into a closed typed set
The engine SHALL define a `DurableBlockerClass` string enum comprising exactly
`transient-rate-limit`, `workflow-state`, `implementation-ci`, `review-findings`,
`environment-auth`, `specification-decision`, `missing-authority`, `upstream-dependency`, and
`workflow-engine-defect`. Every durable-run transition into `blocked` SHALL carry exactly one
member, and its blocked theme SHALL use that member as the budget key. Missing and unknown classes
SHALL fail validation without changing durable state. An already-blocked item SHALL require an
intervening successful recovery before another block can count as repeated evidence.

#### Scenario: Review findings carry their own durable class
- **WHEN** an eligible review non-convergence diagnostic transitions an item into `blocked`
- **THEN** the item's blocked theme SHALL be `review-findings`
- **AND** its budget and recipe selection SHALL be independent of generic CI failures

## ADDED Requirements

### Requirement: Resumed recovery contracts SHALL acquire safety-critical policy migrations
Before a persisted contract is used for recovery, the runtime SHALL upgrade obsolete policy shapes.
A missing newly introduced class SHALL be added from the current default without replacing other
entries. An entry exactly matching a known stale default SHALL be replaced class by class with the current
default so its configured recipes are executable and reachable. A custom entry
SHALL preserve recipe order, budgets, backoff, terminal outcome, fatality, and repeat limit. The
obsolete recipe token `reauthenticate` SHALL be renamed to `verify_authentication` wherever it
appears. The complete migrated policy SHALL be compiled and malformed policies SHALL fail closed.
Migration SHALL NOT rewrite the contract's canonical hash or other immutable identity fields.

#### Scenario: Exact obsolete defaults gain current recipes
- **WHEN** a resumed contract carries the pre-#787 default workflow-state, implementation-CI, authentication, or engine-defect entry
- **THEN** each exact obsolete entry SHALL be replaced by its current default
- **AND** the workflow, CI, and engine classes SHALL include `repair_pipeline_item`

#### Scenario: Missing review class is added without resetting custom policy
- **WHEN** a resumed contract predates `review-findings` and customizes an unrelated class
- **THEN** runtime migration SHALL add the default `review-findings` entry
- **AND** SHALL preserve the unrelated customization byte-for-byte except sanctioned token renames

#### Scenario: Engine fallback remains reachable
- **WHEN** a stale engine-defect default advertises restart followed by `repair_pipeline_item` but carries only one retry/repeat unit
- **THEN** runtime migration SHALL install budgets that permit restart and the later repair action
- **AND** tests SHALL prove both actions can be claimed in order

#### Scenario: Custom policy survives migration
- **WHEN** an entry differs from the known obsolete default
- **THEN** its policy fields and recipe ordering SHALL be preserved
- **AND** only an obsolete `reauthenticate` token SHALL be renamed

#### Scenario: Malformed complete policy fails closed
- **WHEN** a resumed policy contains every class but an invalid budget, recipe, or outcome
- **THEN** migration SHALL fail with typed validation rather than silently defaulting it

#### Scenario: Contract identity is immutable
- **WHEN** runtime policy migration changes the in-memory recovery policy
- **THEN** the canonical contract hash and run identity SHALL remain unchanged
