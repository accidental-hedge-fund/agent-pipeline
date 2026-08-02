## ADDED Requirements

### Requirement: Finalized evidence bundle SHALL include event-stream write-health

The finalized evidence bundle SHALL include the run's event-stream write-health state when
`finalizeRun` writes `summary.json` (and the legacy evidence path). When write-health recorded one
or more failures during the run, the bundle SHALL expose that elevated state so operators and
`pipeline summary` can detect empty, truncated, or partially lost event streams even when
`finalState` reflects a successful stage outcome. When no failures were recorded, the bundle SHALL
expose a healthy or zero-failure write-health representation. The addition is additive and SHALL NOT
change the evidence bundle `schema_version` meaning for existing fields.

#### Scenario: summary.json carries write-health after append failures

- **WHEN** `finalizeRun` is called for a run that recorded at least one `appendEvent` durable
  delivery failure
- **THEN** `summary.json` SHALL include write-health indicating failure
- **AND** a consumer of `pipeline summary` SHALL be able to observe the failure without reading
  stderr from the original process

#### Scenario: healthy run finalizes with non-elevated write-health

- **WHEN** `finalizeRun` is called for a run with no recorded append failures
- **THEN** `summary.json` SHALL include write-health in a healthy or zero-failure state
- **AND** SHALL still include existing finalization fields (`finalState`, `finalizedAt`, stage
  history)

#### Scenario: Successful finalState does not hide write-health failure

- **WHEN** a run reaches a successful terminal stage outcome and `finalizeRun` sets a successful
  `finalState`
- **AND** write-health recorded control-critical or best-effort append failures during the run
- **THEN** `summary.json` SHALL still expose the elevated write-health
- **AND** SHALL NOT omit or clear write-health solely because `finalState` is successful
