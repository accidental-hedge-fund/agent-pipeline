## ADDED Requirements

### Requirement: The intake harness call SHALL be bounded by `cfg.intake_timeout`

The `IntakeDeps.runHarness` interface SHALL accept a `timeoutSec: number` parameter.
The real dep implementation (`realIntakeDeps`) SHALL pass this value as `timeoutSec`
to `invoke()`, overriding the implicit 1200 s default. The `runIntake()` handler SHALL
supply `cfg.intake_timeout` as the `timeoutSec` argument on every call to
`d.runHarness`. A hung or unresponsive endpoint SHALL therefore be killed after
`cfg.intake_timeout` seconds — not after the 20-minute `invoke()` default — and the
sub-command SHALL exit non-zero with an error surfacing the timeout.

#### Scenario: Harness call respects the configured timeout

- **WHEN** `cfg.intake_timeout` is 300 and the intake handler invokes `d.runHarness`
- **THEN** the `timeoutSec` argument passed to the underlying `invoke()` call SHALL be 300
- **AND** an endpoint that does not respond within 300 s SHALL result in a non-zero exit with a timeout error

#### Scenario: Default timeout is 600 s when not configured

- **WHEN** `.github/pipeline.yml` does not set `intake_timeout`
- **THEN** the `timeoutSec` argument to `invoke()` SHALL be 600
