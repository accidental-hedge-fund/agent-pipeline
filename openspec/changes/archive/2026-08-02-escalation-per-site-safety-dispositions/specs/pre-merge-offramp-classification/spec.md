## ADDED Requirements

### Requirement: PreMergeOfframpClass SHALL be a derived projection of the canonical reason vocabulary

The engine SHALL treat `PreMergeOfframpClass` as a pure operator-facing projection derived from
the canonical stage-diagnostic reason code plus closed pre-merge path tags / `BlockerKind`, not
as an independent escalation authority taxonomy. Scoreboard and durable event fields MAY continue
to record `offramp_class`, but human-authority and recovery disposition SHALL continue to come
from the stage-diagnostic projection. Every pre-merge blocked off-ramp SHALL still resolve to
exactly one `PreMergeOfframpClass` member, and that mapping SHALL remain pure and unit-testable
without network I/O.

#### Scenario: Offramp class remains total for pre-merge blocks

- **WHEN** pre-merge blocks with a known blocker kind or path tag
- **THEN** the mapper SHALL return exactly one `PreMergeOfframpClass`
- **AND** recovery/human-authority disposition SHALL still be taken from the stage diagnostic

#### Scenario: Offramp class cannot mint human authority alone

- **WHEN** a pre-merge event records `offramp_class` such as `delta-review` or `other`
- **THEN** the supervisor SHALL NOT create a human hold solely from that offramp class
- **AND** SHALL require the canonical authority predicate for any human hold
)