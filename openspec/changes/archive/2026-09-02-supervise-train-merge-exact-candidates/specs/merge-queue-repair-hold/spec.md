## ADDED Requirements

### Requirement: Merge-queue holds SHALL remain RecoverySupervisor-owned recovery episodes

A merge-queue `merge-conflict`, `checks-failed`, head-drift, unknown-mergeability, timeout, or uncertain-merge hold SHALL be a RecoverySupervisor recovery episode for that candidate. The drive SHALL continue remaining candidates. Bounded repair exhaustion SHALL leave the item owned (Cooling or wait). It SHALL NOT become ownerless STOP or human authority solely because the repair budget is exhausted. Optional repair SHALL remain opt-in and default off. Dry-run SHALL never repair or merge.

#### Scenario: Repair exhaustion stays owned

- **WHEN** apply/drive holds a candidate after the opt-in repair budget is exhausted
- **THEN** RecoverySupervisor SHALL keep that candidate owned
- **AND** the drive SHALL continue remaining candidates
- **AND** the hold SHALL NOT project `human_authority` solely from budget exhaustion

#### Scenario: Head drift invalidates the merge claim

- **WHEN** apply/drive observes that the candidate head moved after the claim was bound
- **THEN** the queue SHALL record a typed hold or restart exact-candidate gates
- **AND** it SHALL NOT merge under the stale inspected head
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Unknown mergeability is an owned wait

- **WHEN** apply/drive observes `mergeable: "UNKNOWN"` that does not resolve within the shared mergeability budget
- **THEN** the item SHALL remain owned as Cooling or an external-condition wait
- **AND** the drive SHALL NOT treat UNKNOWN as MERGEABLE
- **AND** remaining candidates SHALL continue
