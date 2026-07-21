## ADDED Requirements

### Requirement: Doctor SHALL check readiness of every harness adapter the configuration assigns

`pipeline doctor` SHALL include one readiness check per harness adapter that the resolved
configuration assigns to a model-invoking stage. Each check SHALL report, as distinguishable
outcomes, whether the adapter's CLI is missing from `PATH`, present but unauthenticated,
unable to run in headless non-interactive mode, or unable to honor the requested model or
effort. Adapters that no stage assigns SHALL NOT be checked. Each check SHALL carry a stable
identifier naming the adapter, so `pipeline doctor --json` exposes it in the per-check
records like every other check.

#### Scenario: An assigned adapter with a missing CLI fails its check

- **WHEN** the configuration assigns an adapter whose CLI is not on `PATH` and `pipeline doctor` runs
- **THEN** that adapter's readiness check SHALL fail with a message identifying the adapter and the missing CLI

#### Scenario: Unauthenticated and unsupported-setting states are distinguishable

- **WHEN** an assigned adapter's CLI is installed but unauthenticated, or is authenticated but cannot honor the requested model or effort
- **THEN** the check SHALL report an outcome that distinguishes the unauthenticated state from the unsupported-setting state and from the missing-CLI state

#### Scenario: Unassigned adapters are not checked

- **WHEN** the configuration assigns no adapter beyond the profile default and `pipeline doctor` runs
- **THEN** no readiness check SHALL be emitted for the unassigned adapters

#### Scenario: Adapter checks appear in JSON output

- **WHEN** `pipeline doctor --json` runs with an assigned adapter
- **THEN** the `checks` array SHALL contain a record whose identifier names that adapter

### Requirement: Run-start preflight SHALL block a run on an adapter readiness failure

When run-start preflight is enabled, a failing harness-adapter readiness check SHALL abort
the run before the assigned stage's model invocation begins. The pipeline SHALL NOT
substitute a different harness or adapter for the failing one, because substituting would
silently change the harness under evaluation.

#### Scenario: Run-start preflight aborts before the stage runs

- **WHEN** run-start preflight is enabled and an assigned adapter's readiness check fails
- **THEN** the run SHALL abort before the assigned stage invokes a model
- **AND** the stage SHALL NOT be executed on a substitute harness

### Requirement: Adapter readiness checks SHALL be unit-testable without real subprocess or network calls

Harness-adapter readiness checks SHALL run through the existing injectable preflight
dependency seam, so unit tests can simulate every outcome — missing CLI, unauthenticated,
headless unavailable, unsupported model or effort, and ready — using fake executables or
fake execution results, with no real subprocess or network call to any provider.

#### Scenario: Every adapter outcome is simulated through the seam

- **WHEN** the adapter readiness checks are exercised with injected fake execution results
- **THEN** each of the missing, unauthenticated, headless-unavailable, unsupported-setting, and ready outcomes SHALL be reproducible
- **AND** no real subprocess or network call to a provider SHALL be made
