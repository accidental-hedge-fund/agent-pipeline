## ADDED Requirements

### Requirement: Integrated train merge mode SHALL be a loop-isolated operator surface

Operator-facing product docs and golden-rule conventions SHALL name `pipeline train --merge` as an explicit, loop-isolated merge orchestration surface in the same class as `pipeline merge` and `pipeline merge-queue --apply`. Invoking train merge mode SHALL NOT make merge reachable from `pipeline advance` stage dispatch. Repository configuration SHALL NOT enable train merge mode via an `auto_merge` key or equivalent.

#### Scenario: Docs list train merge with other non-advance merge surfaces

- **WHEN** README and host skill policy text describe merge surfaces
- **THEN** they SHALL include `pipeline train --merge` as opt-in and explicit
- **AND** they SHALL state that default advance and default loop still stop at ready-to-deploy

#### Scenario: Golden rule forbids auto_merge and still allows train

- **WHEN** CLAUDE.md and AGENTS.md golden-rule merge text is read
- **THEN** they SHALL forbid an `auto_merge` config key and a merge stage
- **AND** they SHALL allow loop-isolated `pipeline train --merge` as an operator-invoked surface

#### Scenario: Advance isolation tests still pass

- **WHEN** the isolation test suite scans advance dispatch and stage handlers
- **THEN** those paths SHALL remain free of merge mutations
- **AND** the train command module MAY call the merge surface without failing the advance isolation scan
