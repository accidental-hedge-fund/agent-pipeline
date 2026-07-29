## ADDED Requirements

### Requirement: BlockerKind includes ci-exhausted for pre-merge CI budget exhaustion

The `BlockerKind` enum (`BLOCKER_KINDS` in `core/scripts/types.ts`) SHALL include a `ci-exhausted` member used when the pre-merge GitHub CI gate escalates after the per-head-SHA recovery budget is exhausted (re-run / archive-aware recovery / optional assertion fix as applicable). Its `BLOCKER_RECIPES` entry SHALL be a non-empty recipe that directs the operator to inspect the failing check URL(s) and classification in the block reason, fix product test/build failures or address remaining infrastructure issues, push any code fix to the PR head, remove the `blocked` label, then re-run the pipeline. The recipe SHALL state that automatic re-run budget may already have been consumed so a pure re-run without a fix may not be sufficient. The recipe SHALL NOT instruct the operator to use review `--override` as the primary recovery for CI red. Because existing requirements already require `BLOCKER_RECIPES` completeness and snapshot coverage over every `BlockerKind`, adding `ci-exhausted` SHALL update those maps and tests in the same change.

#### Scenario: ci-exhausted is a valid BlockerKind

- **WHEN** `BLOCKER_KINDS` is inspected
- **THEN** it SHALL include the string `ci-exhausted`
- **AND** `BLOCKER_RECIPES["ci-exhausted"]` SHALL be a non-empty string

#### Scenario: setBlocked with ci-exhausted renders the CI recovery recipe

- **WHEN** `setBlocked(cfg, N, reason, "pre-merge", "ci-exhausted")` is called
- **THEN** the posted GitHub comment SHALL contain the `ci-exhausted` recipe text under "### How to unblock"
- **AND** the recipe SHALL direct the operator to fix CI failures and re-run the pipeline after removing `blocked`
- **AND** SHALL NOT present review `--override` as the primary unblock verb for this kind

#### Scenario: pre-merge CI budget exhaustion uses ci-exhausted not bare needs-human

- **WHEN** the pre-merge gate escalates because definitive CI failures remain after the recovery budget for the head SHA is exhausted
- **THEN** the gate SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** SHALL NOT pass only `needs-human` for that escalation path when the dedicated kind is available

#### Scenario: recipe snapshots cover ci-exhausted

- **WHEN** the blocked-recipe snapshot / exhaustiveness tests run
- **THEN** they SHALL assert a non-empty `BLOCKER_RECIPES` entry for `ci-exhausted`
- **AND** SHALL fail if the entry is removed or emptied
