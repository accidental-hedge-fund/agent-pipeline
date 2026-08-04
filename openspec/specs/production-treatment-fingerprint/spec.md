# production-treatment-fingerprint Specification

## Purpose
TBD - created by archiving change provider-neutral-treatment-fingerprint. Update Purpose after archive.
## Requirements
### Requirement: Every production harness invocation SHALL record a provider-neutral treatment fingerprint

The pipeline SHALL record an immutable treatment fingerprint for every production local-CLI harness
invocation that emits treatment or stage-accounting provenance. The fingerprint SHALL include, when
known:

- adapter ID and adapter contract version (or equivalent declaration/contract stamp),
- CLI absolute path and probed CLI version,
- a stable capability hash derived from the adapter's declared capability/declaration surface,
- the role for this invocation (e.g. implementer or reviewer),
- requested model, resolved model, requested effort, and resolved effort as separate fields,
- resolved sandbox/tool policy identity for the invocation,
- prompt-contract and output-contract version stamps (or equivalent delivery/envelope contract
  identifiers),
- fallback state (`true`, `false`, or unknown/null),
- failure reason when the invocation failed for a known typed reason (null/omitted on success).

The fingerprint contract SHALL apply to every configured built-in adapter and every externally
registered or compatibility adapter on the public extension contract. The pipeline SHALL NOT
provide a separate telemetry or fingerprint architecture for any named provider or vendor.

Provider/auth class SHALL appear in the fingerprint only when the CLI or probe actually reports
it. The pipeline SHALL NOT infer provider from the model name, the adapter ID, or the outer host.

#### Scenario: Built-in and extension adapters share one fingerprint shape

- **WHEN** a production invocation runs through a built-in adapter and another runs through an
  externally registered adapter
- **THEN** both SHALL emit the same fingerprint field set (values may differ)
- **AND** neither path SHALL use a vendor-specific parallel record type

#### Scenario: Provider is omitted when unreported

- **WHEN** an adapter's CLI and probe report no provider or auth-route signal
- **THEN** the fingerprint SHALL record provider/auth class as unknown or omit it
- **AND** it SHALL NOT derive a provider value from the requested or resolved model name

#### Scenario: Requested and resolved settings stay separate

- **WHEN** a stage requests a model and effort and telemetry reports a different resolved model
- **THEN** the fingerprint SHALL carry both requested and resolved model values as separate fields
- **AND** SHALL NOT overwrite requested with resolved or resolved with requested

#### Scenario: Fallback unknown is not fabricated false

- **WHEN** the CLI reports no fallback signal
- **THEN** the fingerprint's fallback field SHALL be unknown/null
- **AND** it SHALL NOT be recorded as `false` solely because no signal was present

### Requirement: Production CLI version SHALL come from a once-per-run probe

The pipeline SHALL resolve each harness CLI's version through a once-per-run (or once per distinct
CLI identity within a run) cached probe — the binary/version probe surface owned or shared with
production preflight-on-invoke (#636) — and SHALL thread that value into `AdapterProbe.cliVersion`
and the treatment fingerprint.

The pipeline SHALL NOT spawn a fresh version subprocess on every model call solely to populate
`cliVersion`. When the probe is unavailable or fails, `cliVersion` SHALL remain null/unknown
rather than fabricated. Absolute CLI path SHALL be recorded when resolution succeeds and omitted
or unknown when it does not.

#### Scenario: Successful probe populates cliVersion on accounting

- **WHEN** the once-per-run version probe succeeds for the adapter's CLI and accounting is enabled
- **THEN** the treatment fingerprint and stage accounting provenance SHALL carry the probed CLI
  version
- **AND** `cliVersion` SHALL NOT remain hard-coded null solely because no per-call probe ran

#### Scenario: Probe failure leaves version unknown

- **WHEN** the once-per-run version probe fails or is unavailable
- **THEN** the fingerprint and accounting SHALL record CLI version as null/unknown
- **AND** the stage SHALL NOT be blocked solely because the version probe failed

#### Scenario: No second independent probe path

- **WHEN** both production invoke and production preflight need the CLI version for the same run
  and adapter CLI identity
- **THEN** they SHALL consume the same cached probe result
- **AND** they SHALL NOT each implement an independent always-on per-call version exec

### Requirement: Verified-against version drift SHALL warn fail-soft

The pipeline SHALL emit a fail-soft compatibility warning when a probed CLI version diverges from
an adapter's verified-against identity. Each adapter that documents a CLI version (or build
identity) against which its argv and/or telemetry schema were verified SHALL expose that
verified-against identity in a form readable by tests and by the production probe comparison. The
divergence check SHALL use the documented comparison rule for that adapter family and SHALL write
the warning to run-visible diagnostics.

Version drift alone SHALL NOT block the stage, fail the invocation, or force a harness fallback.

#### Scenario: Divergent probed version warns without blocking

- **WHEN** the probed CLI version diverges from the adapter's recorded verified-against version
- **THEN** the pipeline SHALL emit a compatibility warning naming the adapter, probed version, and
  verified-against version
- **AND** the stage invocation SHALL NOT be blocked solely for that divergence

#### Scenario: Matching version produces no drift warning

- **WHEN** the probed CLI version is compatible with the adapter's verified-against identity under
  the documented rule
- **THEN** the pipeline SHALL NOT emit a version-drift compatibility warning for that adapter on
  that run

### Requirement: Telemetry coverage and cost fields SHALL not zero-fill unknowns

The treatment fingerprint and stage accounting surfaces that expose telemetry coverage SHALL
distinguish available, unavailable, and unknown channels for cost, usage counters, resolved model,
and throttling. Unreported numeric cost or token fields SHALL be null or omitted. The pipeline
SHALL NOT write `0` for cost or token counters unless the harness envelope explicitly reports zero.
Unreported throttling SHALL be null/unknown, not `false`. Unreported resolved model SHALL be null,
not a copy of the requested model.

`cost_source` SHALL remain one of `actual`, `estimated`, or `unknown` per stage-cost-accounting
rules. Telemetry coverage metadata SHALL NOT invent `cost_source: "actual"` when no numeric cost
was recovered.

#### Scenario: Missing cost stays unknown with null cost_usd

- **WHEN** an adapter invocation completes without recoverable cost telemetry and without an
  explicit estimate
- **THEN** the accounting record SHALL use `cost_source: "unknown"` and `cost_usd: null`
- **AND** it SHALL NOT write `cost_usd: 0`

#### Scenario: Missing throttle is null not false

- **WHEN** the adapter's telemetry envelope does not report a throttle signal
- **THEN** the fingerprint and accounting throttle field SHALL be null/unknown
- **AND** it SHALL NOT be recorded as `false`

#### Scenario: Resolved model is not copied from the request

- **WHEN** telemetry does not report a resolved model
- **THEN** `resolvedModel` / `resolved_model` SHALL be null/omitted
- **AND** it SHALL NOT equal the requested model solely by echo

### Requirement: Treatment fingerprint and adapter parsers SHALL be shareable with evals

The pipeline SHALL structure the immutable treatment fingerprint builder and each adapter's
`parseTelemetry` implementation as pure, importable units free of GitHub issue mutation and
eval-cell orchestration so evals-side provenance capture (#653) can consume the same
implementations. This capability SHALL NOT own evals cell wiring, eval-only response fixtures
beyond the shared adapter envelope corpus, or engine/discovery version stamping (#763).

#### Scenario: Fingerprint builder is pure

- **WHEN** the treatment fingerprint is built from adapter declaration, probe, request, invocation,
  telemetry, role, and policy inputs
- **THEN** the builder SHALL NOT require a live GitHub client or eval executor
- **AND** the same builder SHALL be callable from unit tests with fakes

#### Scenario: Engine version is out of scope

- **WHEN** a production treatment fingerprint is recorded
- **THEN** it SHALL carry harness CLI version from the adapter probe when known
- **AND** it SHALL NOT substitute or require the pipeline engine SHA as the CLI version field

