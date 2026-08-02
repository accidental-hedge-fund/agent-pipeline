## ADDED Requirements

### Requirement: CI recovery durable state SHALL be the stage-attempt ledger

For each PR head SHA observed with definitive CI failures, the gate SHALL track recovery steps
already consumed through the stage-attempt ledger (shared recovery-attempt family), not through a
private `pre-merge-ci-recovery.json` authority. Actions SHALL include at least: rebase,
failed-workflow re-run, archive-fail recovery, and assertion-fix when enabled. Product ladder order
and one-shot-per-head budgets remain as specified by existing durable-budget requirements; only the
authority store consolidates. Migration MAY read legacy runDir JSON once into the ledger.

#### Scenario: Restart without pre-merge-ci-recovery.json honors ledger re-run attempt

- **WHEN** the ledger records workflow re-run attempted for head `H`
- **AND** `pre-merge-ci-recovery.json` is absent on resume
- **AND** head `H` is still settled red
- **THEN** the gate SHALL NOT re-request workflow re-run for `H`
- **AND** SHALL continue remaining budget steps or escalate with `ci-exhausted`

#### Scenario: Claim-before-side-effect for CI recovery actions

- **WHEN** the gate is about to invoke rebase, re-run, archive-fail recovery, or assertion-fix for
  head `H`
- **THEN** it SHALL claim the corresponding ledger action for `H` before the side effect
- **AND** on claim persistence failure SHALL fail closed without performing the side effect

#### Scenario: New code does not require writing pre-merge-ci-recovery.json

- **WHEN** a CI recovery attempt completes for head `H`
- **THEN** the durable authority write SHALL go through the stage-attempt ledger
- **AND** production correctness SHALL NOT depend on creating or updating
  `pre-merge-ci-recovery.json`
