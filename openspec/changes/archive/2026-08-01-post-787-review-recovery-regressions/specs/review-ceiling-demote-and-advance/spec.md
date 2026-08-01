## MODIFIED Requirements

### Requirement: High or critical findings SHALL hard-park at the round ceiling regardless of ceiling_action
At the repair-eligible `max_adversarial_rounds` ceiling, high or critical findings SHALL never be
demoted. When every blocker has consumed an eligible fix attempt, the stage SHALL remain blocked as
`review-findings` with canonical `review-findings` recovery evidence and SHALL NOT file a
demotion follow-up. This mechanical block SHALL NOT transition to `needs-human`. If any blocker is
new to the eligible lineage, the entire verdict SHALL route to `fix-N` rather than treating stale
issue history as a spent ceiling.

#### Scenario: Recurring high finding at the ceiling enters recovery
- **WHEN** a high or critical blocker reaches the repair-eligible ceiling after its proven fix attempt
- **THEN** it SHALL remain blocking and SHALL enter typed mechanical recovery
- **AND** it SHALL NOT be demoted or transitioned to `needs-human`

#### Scenario: New high finding at an apparent issue-wide ceiling receives a fix
- **WHEN** old issue comments would satisfy the numeric ceiling but the current blocker lacks a verified repair cycle
- **THEN** the blocker SHALL route to `fix-N`

### Requirement: ceiling_action park SHALL preserve the current hard-park behavior
The pipeline SHALL preserve blocking quality when `ceiling_action` is `park` and every blocker has consumed its verified repair opportunity,
the stage SHALL preserve blocking quality but SHALL assign the block to the durable recovery
controller. It SHALL emit `review-findings` and a canonical recover disposition, without demotion,
override, follow-up issue, `needs-human` transition, or human-intervention event.

#### Scenario: Default park preserves blocking without human authority
- **WHEN** all remaining blockers have consumed eligible fix attempts and `ceiling_action` is `park`
- **THEN** the stage SHALL remain blocked and recoverable
- **AND** no blocker SHALL be demoted or converted into human authority

### Requirement: The recurrence early-park SHALL NOT be governed by ceiling_action
Exact eligible recurrence SHALL remain blocking independent of `ceiling_action`. Before the
repair-eligible ceiling it SHALL enter typed mechanical recovery. At the ceiling,
`demote_and_advance` MAY demote and defer a fully recurring below-high set through the audited
existing path; high/critical findings SHALL instead enter mechanical recovery. New or mixed
blockers SHALL receive `fix-N` and SHALL not be governed by recurrence or ceiling disposition.

#### Scenario: Recurring medium before the ceiling enters recovery
- **WHEN** a medium blocker recurs after a proven fix before the repair-eligible ceiling
- **THEN** it SHALL enter typed mechanical recovery regardless of `ceiling_action`

#### Scenario: Fully recurring medium at a demote ceiling can advance
- **WHEN** all blockers are eligible below-high recurrences at the ceiling
- **AND** `ceiling_action` is `demote_and_advance`
- **THEN** the audited demotion and follow-up path SHALL remain available

#### Scenario: New blocker is not a ceiling blocker
- **WHEN** any current blocker lacks eligible verified repair history
- **THEN** the verdict SHALL route to `fix-N`
