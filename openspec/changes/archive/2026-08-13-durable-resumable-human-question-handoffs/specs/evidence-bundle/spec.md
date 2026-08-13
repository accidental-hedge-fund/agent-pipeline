## ADDED Requirements

### Requirement: Evidence bundle SHALL record human-question handoff lifecycle outcomes

When a run creates, answers, rejects, supersedes, expires, or attempts resume validation on a human-question handoff, the evidence bundle (or its run-scoped companion artifacts referenced from the bundle) SHALL record the handoff id, class, authority mode, status transition, actor when present, candidate SHA and bound content hashes, and resume validation result. Handoff evidence is a supplement: missing write of optional display fields SHALL NOT by itself clear a required human hold, and removing the bundle SHALL NOT delete the durable handoff store used for resume.

#### Scenario: Create is visible in evidence

- **WHEN** a handoff is created during a pipeline run that finalizes an evidence bundle
- **THEN** the bundle or its referenced handoff evidence SHALL include the new handoff id and `pending` status
- **AND** SHALL include class and authority_mode

#### Scenario: Resume refusal is recorded

- **WHEN** resume validation fails for stale SHA or superseded status
- **THEN** evidence SHALL record the refusal reason
- **AND** SHALL NOT record a successful advance for that attempt

#### Scenario: Answer provenance is recorded

- **WHEN** an eligible actor answers a handoff
- **THEN** evidence SHALL include responder identity reference, decision, and timestamp
- **AND** SHALL include whether the handoff was authority-bearing
