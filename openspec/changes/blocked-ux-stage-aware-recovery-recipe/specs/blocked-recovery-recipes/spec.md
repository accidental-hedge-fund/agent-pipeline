## ADDED Requirements

### Requirement: BlockerKind enum defines a closed set of blocker classes
The pipeline SHALL define a `BlockerKind` string-enum in `core/scripts/types.ts` covering every structurally-distinct failure class that can result in a blocked issue. The enum SHALL include at minimum: `needs-human`, `test-gate-exhausted`, `no-commits`, `harness-failure`, `openspec-invalid`, `openspec-stale-delta`, `merge-conflict`, `worktree-missing`, `worktree-creation-failed`, `pr-creation-failed`, `plan-gen-failed`, `push-failed`.

#### Scenario: BlockerKind enum is exhaustive for all call sites
- **WHEN** every `setBlocked(...)` call in `planning.ts`, `fix.ts`, and `pre_merge.ts` is inspected
- **THEN** each call SHALL pass a `kind` value drawn from `BlockerKind`
- **AND** no call SHALL be added without a corresponding `BlockerKind` member

#### Scenario: BLOCKER_RECIPES map covers every kind
- **WHEN** the `BLOCKER_RECIPES` map is inspected at runtime
- **THEN** it SHALL contain a non-empty string entry for every value in the `BlockerKind` enum
- **AND** no `BlockerKind` value SHALL be absent from the map

### Requirement: setBlocked renders a kind-specific recovery recipe
The `setBlocked` function SHALL accept an optional `kind?: BlockerKind` parameter. When `kind` is provided, the "### How to unblock" section of the blocked comment SHALL render the static recipe string associated with that kind from `BLOCKER_RECIPES`. When `kind` is omitted, the function SHALL default to `needs-human` behavior for backward compatibility.

#### Scenario: kind-specific recipe appears in blocked comment
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the posted GitHub comment SHALL contain the test-gate-exhausted recipe text under "### How to unblock"
- **AND** SHALL NOT contain the generic `--unblock` instruction

#### Scenario: needs-human kind renders the override/fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "needs-human")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix findings and re-run OR use `--override "<key>: <reason>"` to record a disposition

#### Scenario: test-gate-exhausted kind renders the test-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "test-gate-exhausted")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to fix the failing tests, commit, and re-run the pipeline

#### Scenario: openspec-invalid kind renders the validate-and-fix recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "openspec-invalid")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to run `openspec validate <change>` locally, fix errors, commit, and re-run

#### Scenario: merge-conflict kind renders the rebase recipe
- **WHEN** `setBlocked(cfg, N, reason, stage, "merge-conflict")` is called
- **THEN** the "### How to unblock" section SHALL direct the operator to rebase on the latest target branch, resolve conflicts, push, and re-run

#### Scenario: missing kind defaults to needs-human recipe
- **WHEN** `setBlocked(cfg, N, reason, stage)` is called without a `kind` argument
- **THEN** the comment SHALL render the `needs-human` recipe (the pre-change behavior)
- **AND** no crash or validation error SHALL occur

### Requirement: Recovery recipes are pinned by snapshot tests
The pipeline test suite SHALL include a snapshot or string-assertion test that verifies the rendered comment text for every `BlockerKind` value. A recipe string that changes or goes missing SHALL cause the test to fail.

#### Scenario: snapshot test fails when a recipe string is changed
- **WHEN** the `BLOCKER_RECIPES` entry for any kind is edited
- **THEN** the corresponding snapshot assertion SHALL fail at `npm test`
- **AND** the failure message SHALL identify which kind's recipe changed

#### Scenario: snapshot test covers all kinds
- **WHEN** a new value is added to `BlockerKind`
- **THEN** there SHALL be a test asserting that `BLOCKER_RECIPES` contains a non-empty entry for that value
- **AND** the test SHALL fail if the entry is absent
