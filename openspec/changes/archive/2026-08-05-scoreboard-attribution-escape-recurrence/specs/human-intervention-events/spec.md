## ADDED Requirements

### Requirement: human_intervention events SHALL carry or inherit engine and discovery attribution

Each newly emitted `human_intervention` event SHALL expose engine version, engine commit
SHA (or explicit unresolved), and discovery-channel either as additive event fields or via
the documented inheritance rule from `run.json` / run-level defaults used by scoreboard
collectors. New producers SHALL resolve discovery-channel at write time from the caller's
validated channel when present, else from the active run's persisted `run.json`
`discovery_channel` stamp when present, and SHALL write that value on the event when
resolved. Producers SHALL NOT invent `live-run` when neither source yields a closed-set
channel; unresolved channel MAY omit the field and MAY emit a non-fatal diagnostic.
Emission SHALL remain non-fatal: attribution enrichment failure SHALL NOT change the stage
outcome. Existing required fields (`schema_version`, `type`, `at`, `kind`, `stage`,
`issue`, `detail`, optional `ref`) SHALL remain.

#### Scenario: Override intervention is attributable

- **WHEN** an operator supplies `--override` and a `human_intervention` event with kind
  `human-risk-override` is appended
- **THEN** scoreboard human-touch collectors SHALL be able to read engine identity and
  discovery-channel for that event via inline fields or documented inheritance
- **AND** `kind` SHALL remain `human-risk-override`

#### Scenario: Write-time discovery channel from run stamp

- **WHEN** a `human_intervention` event is emitted without a caller-supplied
  `discovery_channel`
- **AND** the active run's `run.json` has a valid `discovery_channel` (for example
  `review-batch`)
- **THEN** the written event SHALL include that `discovery_channel` inline
- **AND** SHALL NOT invent `live-run` in place of the run stamp

#### Scenario: Unresolved discovery channel is not invented as live-run

- **WHEN** a `human_intervention` event is emitted without a caller channel
- **AND** no valid run-level `discovery_channel` stamp is available
- **THEN** the event SHALL still be written with its core fields
- **AND** SHALL NOT set `discovery_channel` to `live-run` by default
- **AND** a non-fatal unresolved-attribution diagnostic MAY be recorded

#### Scenario: Attribution enrichment failure is non-fatal

- **WHEN** engine identity cannot be resolved at intervention emission time
- **THEN** the `human_intervention` event SHALL still be written with its core fields
- **AND** unresolved identity SHALL be explicit or inherit as null/unknown
- **AND** the stage outcome SHALL not change solely due to missing identity

#### Scenario: Historical intervention without new fields remains countable

- **WHEN** a pre-change `human_intervention` event lacks engine and discovery fields
- **THEN** human-touch aggregates SHALL still count the event as a touch when kind is in
  scope
- **AND** missing-attribution evidence MAY be recorded without crashing the scan
