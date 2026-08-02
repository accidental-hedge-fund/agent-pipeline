## REMOVED Requirements

### Requirement: Auto-format commits are classified as pipeline-internal

**Reason:** Superseded by the tested #228 disposition and the neutral pipeline-commits classifier: auto-format subjects are **not** pipeline-internal. See the replacement requirement below.

## ADDED Requirements

### Requirement: Auto-format commits are NOT classified as pipeline-internal

The `isPipelineInternalCommit` predicate (owned by the neutral pipeline-commits module) SHALL return false for commits whose message begins with `chore: auto-format (#`. Auto-format commits are developer/format commits for SHA-gate purposes: when they are the only new commits since a review verdict, the gate SHALL proceed through its normal non-internal path (diff-hash cache / re-review rules), not the pipeline-internal exemption. This requirement aligns the living spec with the tested #228 disposition and supersedes any prior wording that treated auto-format subjects as pipeline-internal.

#### Scenario: Auto-format commit is not pipeline-internal

- **WHEN** `isPipelineInternalCommit` is called with `chore: auto-format (#182)`
- **THEN** it SHALL return false

#### Scenario: Auto-format commit does not use the internal-only exemption

- **WHEN** the only new commit since the last review verdict begins with `chore: auto-format (#`
- **THEN** the review-SHA gate SHALL NOT treat that commit as pipeline-internal
- **AND** SHALL apply the non-internal path (diff-hash cache check and subsequent rules) rather than the internal-commit-only exemption

#### Scenario: Developer fix commit alongside auto-format still re-triggers review rules

- **WHEN** new commits include both a `chore: auto-format (#` commit and a developer fix commit (e.g. `fix:` prefix)
- **THEN** the review-SHA gate SHALL treat both as non-internal
- **AND** SHALL re-trigger review or delta evaluation as normal when the diff hash changes
