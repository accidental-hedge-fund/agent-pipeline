## ADDED Requirements

### Requirement: Progressive-planning depth choices SHALL NOT drop open or deferred assumption lineage

When progressive-planning policy (or any planning-depth selection) chooses a lighter planning treatment, the engine SHALL still retain assumption and open-question lineage records whose latest status is `open` or `deferred`. The engine SHALL NOT delete, omit from carry-forward projections, or mint replacement identities solely because `planning_depth` is `minimal` or the routing action is `lightweight_plan`. Unresolved items SHALL remain queryable for implementation and review telemetry for the same run.

#### Scenario: lightweight plan keeps open assumptions

- **WHEN** planning completes with `planning_depth: "minimal"` (or routing action `lightweight_plan`)
- **AND** at least one assumption remains `open`
- **THEN** a current-state projection of assumption lineage for that run SHALL still include those `assumption_id` values with status `open`

#### Scenario: preserve_assumptions does not create duplicate identities

- **WHEN** progressive-planning routing attaches `preserve_assumptions` for existing open items
- **THEN** the engine SHALL reuse existing `assumption_id` values
- **AND** SHALL NOT create a second identity for the same logical assumption solely for the preserve action

#### Scenario: human-authority handoff includes open set

- **WHEN** routing resolves to `request_human_authority` and open or deferred assumptions exist
- **THEN** the open/deferred assumption set SHALL remain reconstructable from the run lineage stream for the handoff surface
- **AND** SHALL NOT be cleared as a side effect of parking for human authority

#### Scenario: assumption_id list not count alone for reconstructability

- **WHEN** a progressive-planning recommendation carries `preserve_assumptions` with supplied `open_or_deferred_assumption_ids`
- **THEN** those `assumption_id` values SHALL match open or deferred rows in the run’s current-state lineage projection
- **AND** a numeric open/deferred count without ids SHALL NOT be treated as sufficient proof that the underlying set is reconstructable

#### Scenario: same ids across lightweight deep and human paths

- **WHEN** the same open and deferred `assumption_id` values are present on a run
- **AND** offline composition is evaluated under lightweight, deepen, and `request_human_authority` inputs
- **THEN** each recommendation path that attaches `preserve_assumptions` SHALL echo those same `assumption_id` values
- **AND** SHALL NOT mint replacement identities

#### Scenario: contradictory count and id list is rejected

- **WHEN** offline composition is given a non-empty `open_or_deferred_assumption_ids` list
- **AND** a numeric `open_or_deferred_assumption_count` that does not equal the deduped id list length
- **THEN** composition SHALL reject the input before producing a recommendation
- **AND** when only ids are supplied, the open count used for routing SHALL be derived from the deduped id list
