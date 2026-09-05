## ADDED Requirements

### Requirement: Recovery SHALL NOT classify an actionable review-stage item as noop after a new candidate epoch

RecoverySupervisor SHALL treat a review-stage item as actionable for the new candidate epoch when a non-pipeline-internal HEAD change starts that epoch and the issue is at or is returned to `review-1` or `review-2`. Recovery SHALL persist or resume a Recovery Episode keyed to the new candidate epoch. It SHALL NOT classify the item as noop solely because checks on the new HEAD are pending. It SHALL NOT classify the item as noop solely because a prior failure episode, strategy cursor, exhaustion, or Cooling record existed for the previous epoch. Pending checks MAY still wait CI for stages that already require green checks. They SHALL NOT suppress exact-SHA review after the epoch change.

#### Scenario: Pending checks do not noop review-1 after epoch change

- **WHEN** the candidate epoch changes from S to H because of a non-pipeline-internal commit
- **AND** the issue is at `review-1` or is returned to `review-1`
- **AND** GitHub checks for H are pending
- **THEN** RecoverySupervisor SHALL NOT classify the item as noop solely from those pending checks
- **AND** SHALL keep review-1 actionable for H

#### Scenario: Prior-epoch failure episode does not noop the new epoch

- **WHEN** a Recovery Episode recorded failure, strategy exhaustion, or Cooling for candidate epoch S
- **AND** the candidate epoch then changes to H
- **THEN** RecoverySupervisor SHALL persist or resume an episode keyed to H
- **AND** SHALL NOT classify the review-stage item as noop solely from the S episode
- **AND** the S cursor SHALL NOT authorize skipping review of H
