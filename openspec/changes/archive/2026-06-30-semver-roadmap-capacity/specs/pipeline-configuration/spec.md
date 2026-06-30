## ADDED Requirements

### Requirement: Config SHALL accept an optional strict `roadmap.release_capacity` block

`PartialConfigSchema` in `config.ts` SHALL accept an optional `release_capacity` sub-block under
the `roadmap:` block, with strict validation. Its fields SHALL be `effort_budget` (a positive
number — the per-milestone effort-points capacity used by the `semver` model, optional) and
`isolate_breaking` (a boolean — whether a breaking-change issue is given its own milestone,
optional). An unknown sub-key under `release_capacity` SHALL be rejected by strict-schema
validation, consistent with the other `roadmap:` fields. When the block is absent, the engine
SHALL apply capacity-aware defaults (an internal default effort budget and breaking-change
isolation enabled) — the `semver` model SHALL be capacity-aware with no configuration. The block
SHALL tune the capacity model only; it SHALL NOT reintroduce a fixed issue-count cap, and it SHALL
NOT affect the `continuous` model or the `pipeline release` refusal gate.

#### Scenario: Valid release_capacity block resolves

- **WHEN** `.github/pipeline.yml` sets:
  ```yaml
  roadmap:
    release_capacity:
      effort_budget: 12
      isolate_breaking: false
  ```
- **THEN** `resolveConfig()` SHALL succeed
- **AND** `config.roadmap.release_capacity.effort_budget` SHALL equal `12`
- **AND** `config.roadmap.release_capacity.isolate_breaking` SHALL be `false`

#### Scenario: Absent release_capacity uses capacity-aware defaults

- **WHEN** `.github/pipeline.yml` has a `roadmap:` block with no `release_capacity` key
- **THEN** `resolveConfig()` SHALL succeed
- **AND** the `semver` model SHALL still group milestones by capacity using internal defaults (breaking-change isolation enabled)

#### Scenario: Unknown sub-key under release_capacity rejected

- **WHEN** `.github/pipeline.yml` sets an unrecognized key under `roadmap.release_capacity` (e.g. `lane_size: 5`)
- **THEN** `resolveConfig()` SHALL throw a strict-schema parse error identifying the offending key

#### Scenario: Non-positive effort_budget rejected

- **WHEN** `roadmap.release_capacity.effort_budget` is set to `0` or a negative number
- **THEN** `resolveConfig()` SHALL throw a parse error identifying `effort_budget` as invalid
