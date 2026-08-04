## ADDED Requirements

### Requirement: Machine-readable telemetry mode SHALL be fixture-verified before an adapter declares it

An adapter SHALL declare `telemetry: "jsonl"` (or the contract-equivalent machine-readable mode)
only when its machine-readable output schema has been verified against **recorded fixtures**
checked into the repository. Flag existence in CLI help alone SHALL NOT justify declaring
machine-readable telemetry.

When telemetry is declared machine-readable, the adapter SHALL:

1. enable only the verified output-mode flags in `buildInvocation` (subject to any existing
   telemetry kill-switch),
2. implement `parseTelemetry` such that fixture inputs recover assistant text for stdout consumers
   and recover only those cost, usage, `resolvedModel`, and `throttled` fields actually present in
   the fixtures,
3. never throw from `parseTelemetry` on truncated, empty, or unparseable input (degrade to nulls).

When verification is incomplete or the CLI has no documented machine-readable mode, the adapter
SHALL keep `telemetry: "none"`, keep plain/text invocation flags, and return empty/null telemetry
fields — leaving accounting at unknown — rather than guessing envelope keys.

Built-in adapters that already declare machine-readable telemetry (`claude`, `codex`) SHALL remain
subject to the same fixture-or-equivalent regression coverage for any schema they claim.

#### Scenario: Unverified adapter remains telemetry none

- **WHEN** a built-in adapter's machine-readable mode has not been verified against recorded
  fixtures
- **THEN** that adapter SHALL declare `telemetry: "none"`
- **AND** `parseTelemetry` SHALL NOT invent cost, resolved model, or throttle values

#### Scenario: Fixture-verified adapter may declare jsonl

- **WHEN** recorded fixtures for an adapter's machine-readable envelope exist and unit tests prove
  `parseTelemetry` recovers assistant text and the claimed field classes from those fixtures
- **THEN** that adapter MAY declare machine-readable telemetry and enable the verified output-mode
  flags
- **AND** fields absent from the fixtures SHALL remain null/unknown in the parser result

#### Scenario: Unparseable capture degrades without throwing

- **WHEN** `parseTelemetry` is invoked with empty, truncated, or non-matching capture text on any
  registered adapter
- **THEN** it SHALL return a result object with nulls for unrecovered fields
- **AND** it SHALL NOT throw

#### Scenario: Extension adapters follow the same verification rule

- **WHEN** an externally registered adapter declares machine-readable telemetry
- **THEN** the shared conformance kit or fixture registration path SHALL require the same
  non-throwing parse and no-invented-resolved-model guarantees as built-ins
- **AND** production code SHALL NOT branch on vendor name to accept the declaration

### Requirement: Adapter probe cliVersion SHALL be threaded from the shared run probe

When constructing treatment identity via `describeTreatment`, the harness invocation path SHALL
supply `AdapterProbe.cliVersion` from the once-per-run (or once per CLI identity) cached version
probe result for that adapter's CLI, not a hard-coded null when a successful probe result exists
for the run.

`describeTreatment` SHALL continue to accept null `cliVersion` when the probe is unavailable.
Adapters SHALL copy `probe.cliVersion` into `HarnessTreatment.cliVersion` rather than inventing a
version string.

#### Scenario: Probe result reaches treatment identity

- **WHEN** invoke constructs treatment identity and a cached version probe for the adapter CLI is
  present
- **THEN** the `AdapterProbe` passed to `describeTreatment` SHALL carry that `cliVersion`
- **AND** the resulting `HarnessTreatment.cliVersion` SHALL equal the probe value

#### Scenario: Absent probe keeps null cliVersion

- **WHEN** invoke constructs treatment identity and no version probe result is available
- **THEN** `AdapterProbe.cliVersion` SHALL be null
- **AND** `HarnessTreatment.cliVersion` SHALL be null

### Requirement: Built-in adapters SHALL record a verified-against CLI identity for drift comparison

Each built-in adapter that freezes argv or telemetry schema against a specific CLI version SHALL
record that verified-against identity in structured form readable by tests and by the production
version-drift warning path (in addition to any human header comment). The identity SHALL name the
CLI and the version (and optional build id) used for verification.

#### Scenario: Verified-against identity is machine-readable

- **WHEN** the built-in adapter metadata is loaded in tests
- **THEN** each built-in that claims argv or telemetry verification SHALL expose a non-empty
  verified-against version identity
- **AND** a regression test SHALL fail if the structured identity is missing for an adapter that
  enables machine-readable telemetry

### Requirement: Telemetry recovery SHALL not echo requested settings as resolved

`parseTelemetry` and treatment construction SHALL set `resolvedModel` and `resolvedEffort` only
from CLI-reported signals (telemetry envelope or documented probe). They SHALL NOT copy
`requestedModel` or `requestedEffort` into the resolved fields to fill gaps. `throttled` and
`fallback` SHALL remain null when unreported.

#### Scenario: Plain or empty telemetry leaves resolved model null

- **WHEN** an adapter with `telemetry: "none"` or an empty capture runs `parseTelemetry` and
  treatment description with a non-null requested model
- **THEN** `resolvedModel` SHALL be null
- **AND** `throttled` SHALL be null
