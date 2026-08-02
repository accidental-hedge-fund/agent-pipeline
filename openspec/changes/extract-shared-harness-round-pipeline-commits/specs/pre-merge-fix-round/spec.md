## MODIFIED Requirements

### Requirement: The pre-merge auto-fix commit SHALL be developer-classified and traceable

The auto-fix commit SHALL carry the run's `Issue: #N` and `Pipeline-Run: <id>` git trailers and
SHALL be classified as a developer commit, so the review-SHA gate re-reviews it. `isPipelineInternalCommit`
(from the neutral pipeline-commits module) SHALL continue to return `false` for the auto-fix commit
subject; the recognizable marker used by the one-attempt bound (a commit-subject prefix or dedicated
trailer) SHALL NOT cause `isPipelineInternalCommit` to return `true`.

#### Scenario: auto-fix commit carries traceability trailers

- **WHEN** the auto-fix attempt commits a fix
- **THEN** the commit message SHALL include `Issue: #<issue-number>` and `Pipeline-Run: <run-id>`
  trailers

#### Scenario: auto-fix commit is not pipeline-internal

- **WHEN** `isPipelineInternalCommit` is called with the auto-fix commit subject
- **THEN** it SHALL return `false`
- **AND** the review-SHA gate SHALL treat the auto-fix commit as a developer commit that invalidates
  the prior verdict and triggers the re-review

## ADDED Requirements

### Requirement: Pre-merge bounded auto-fix SHALL use the shared harness-round helper

The pre-merge bounded auto-fix path SHALL run its implementer-round skeleton (head capture, invoke,
salvage on dirty no-commit, commit subject amendment / verification, push coordination) through the
shared harness-round helper rather than a private full copy of that skeleton. One-attempt bound,
noop-clean outcome, amend-to-auto-fix-prefix, and post-fix delta re-review SHALL remain
pre-merge product rules and SHALL keep their pre-change outcomes.

#### Scenario: Auto-fix skeleton is shared

- **WHEN** pre-merge launches a bounded auto-fix implementer round
- **THEN** head capture, invoke, and salvage sequencing SHALL go through the shared harness-round helper
- **AND** a successful fix SHALL still be pushed and re-reviewed exactly once under the existing
  one-attempt bound

#### Scenario: Noop-clean outcome is preserved

- **WHEN** the auto-fix harness exits with no new commit and a clean worktree
- **THEN** the path SHALL expose the existing noop-clean outcome for re-verify
- **AND** SHALL NOT create a salvage commit or consume a second auto-fix attempt incorrectly
