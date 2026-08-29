## MODIFIED Requirements

### Requirement: README SHALL describe durable loop without requiring external goal-loop

README SHALL describe durable multi-item loop without requiring external
goal-loop. Text about `pipeline loop` / durable multi-item runs and about the
doctor check `loop:contract-coherence` SHALL match in-repo loop reality: durable
loop does not require an externally installed goal-loop skill. The README SHALL
NOT state that goal-loop must be installed for `pipeline loop` to work. Where
`loop:contract-coherence` is documented, absence
of goal-loop SHALL be described as non-failing (skip/warn/optional), not as a
hard doctor failure or install blocker.

#### Scenario: Loop section does not require goal-loop

- **WHEN** a reader reads the durable multi-item / `pipeline loop` section
- **THEN** the section SHALL NOT require installing goal-loop as a prerequisite
  for loop
- **AND** it SHALL be consistent with the in-repo durable loop supervisor

#### Scenario: Doctor table matches optional goal-loop semantics

- **WHEN** the README documents the `loop:contract-coherence` doctor check
- **THEN** it SHALL NOT claim the check fails solely because goal-loop is absent
- **AND** it SHALL NOT claim `pipeline loop` itself requires that check to pass
  via an external goal-loop install
