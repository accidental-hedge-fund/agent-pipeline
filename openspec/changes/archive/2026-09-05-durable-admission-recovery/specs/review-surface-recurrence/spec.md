## ADDED Requirements

### Requirement: A settled-surface evidence rule SHALL distinguish recurrence from a newly discovered defect

The pre-merge delta gate MAY demote a blocking finding for lacking new HEAD-state evidence only when the finding matches a specific settled finding by stable key or guarded title similarity on the same surface. Surface identity alone SHALL NOT establish recurrence. A distinct high or critical finding discovered in a file and category that previously contained another settled finding SHALL remain blocking and follow normal fix or recovery routing.

#### Scenario: New high finding shares a settled surface

- **WHEN** a delta review reports a high finding on the same file and category as a settled finding
- **AND** the new finding does not match the settled finding by stable key or guarded title similarity
- **THEN** the new finding SHALL remain blocking even when its body contains no quoted HEAD-state evidence
- **AND** the gate SHALL NOT emit an empty blocking-key set or advance on the strength of surface identity alone

#### Scenario: Specific settled finding is re-raised without evidence

- **WHEN** a delta review re-raises the same settled finding by stable key or guarded title similarity on the same surface
- **AND** its body contains no current HEAD-state evidence
- **THEN** the existing settled-finding advisory routing MAY apply
- **AND** the audit event SHALL identify the specific settled finding that matched

#### Scenario: Post-auto-fix residual remains authoritative

- **WHEN** the bounded pre-merge auto-fix produces a new exact candidate SHA
- **AND** the immediate re-review reports a blocking residual or a newly discovered blocker
- **THEN** that post-fix verdict SHALL remain blocking without historical settled-surface or advisory carry-forward demotion
