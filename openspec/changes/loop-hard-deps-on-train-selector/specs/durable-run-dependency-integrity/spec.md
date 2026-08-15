## ADDED Requirements

### Requirement: dependency_deadlock SHALL NOT fire for non-admitted or soft dependency references

The engine SHALL form eligibility gates and the `dependency_deadlock` stop only from
**admitted hard waits** present on each item's compiled `depends_on` and
`external_depends_on` after work-list hard-wait admission. References that population
recorded only as `ignored_dep` (including off-selector open issues, closed/merged
targets, and soft Related prose that never entered the raw declared set) SHALL NOT
make an item ineligible and SHALL NOT appear in a deadlock chain as an awaited
dependency. Real admitted in-snapshot open prerequisites retain existing hold and
deadlock behavior. This requirement composes with — and does not weaken — the rule
that dependency-independent items continue while others are gated.

#### Scenario: Off-selector open reference does not deadlock the ship

- **WHEN** the only remaining non-terminal item is issue `A`
- **AND** `A`'s body still mentions open issue `B` under `## Dependencies` or via
  `Depends on: #B`
- **AND** hard-wait admission ignored `B` because `B` is not on the train selector
- **AND** `A` has no admitted hard waits remaining
- **THEN** `A` SHALL be eligible to start subject to other non-dependency gates
- **AND** the run SHALL NOT stop with reason `dependency_deadlock` solely because of `B`

#### Scenario: Admitted open on-selector dependency still deadlocks when alone

- **WHEN** the only remaining non-terminal items are gated on admitted hard waits whose
  targets are open on the selector and not yet terminal-success
- **AND** no item is `in_progress` and none is eligible
- **THEN** the run SHALL stop with reason `dependency_deadlock`
- **AND** the deadlock chain SHALL name only admitted hard-wait dependencies

#### Scenario: Soft Related prose never appears in a deadlock chain

- **WHEN** issue `A` mentions `#B` only under Related / see-also soft prose
- **THEN** no deadlock chain entry for `A` SHALL name `B` as an awaited dependency
- **AND** no `dependency_deadlock` SHALL be attributed to that soft reference

### Requirement: External pending gates SHALL apply only to remaining admitted external hard waits

The engine SHALL apply external pending gates only to ids that remain on
`external_depends_on` after hard-wait admission. When an item still carries such ids, the
existing three-valued external verification (satisfied / pending / unsatisfiable) and
skip/deadlock rules continue to apply to those ids. Population that drops off-selector
and closed candidates before compile SHALL leave `external_depends_on` empty for those
candidates so they never enter external pending. The engine SHALL NOT re-introduce an
ignored off-selector open issue as a pending external gate on a later supervisor tick
without a fresh compile that re-admits it under the same admission rules.

#### Scenario: Ignored off-selector id is absent from external_depends_on

- **WHEN** issue `A` declares `#B` and admission ignores `B` as `not_on_selector`
- **THEN** the compiled item for `A` SHALL have no `B` on `external_depends_on`
- **AND** external status computation SHALL NOT treat `B` as a pending gate for `A`

#### Scenario: Remaining admitted external hard wait still blocks when pending

- **WHEN** an item retains an admitted external hard wait id on `external_depends_on`
- **AND** live observation classifies that id as pending
- **THEN** that item SHALL NOT be eligible to start
- **AND** existing deadlock rules for a frontier gated only on such pending externals
  continue to apply
