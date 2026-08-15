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
