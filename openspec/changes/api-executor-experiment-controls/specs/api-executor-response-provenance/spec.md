## ADDED Requirements

### Requirement: The exact sent request payload SHALL be recorded after secret redaction

For every `model-endpoint` invocation, the pipeline SHALL record in run evidence the exact
request payload that was sent — the resolved model, the transmitted params, the encoded
reasoning control, the structured-output field when present, and the names of the headers
sent — with every secret-bearing value redacted. The recorded payload SHALL reflect what was
actually transmitted after override merging, not the committed configuration. The credential
value and the resolved value of any environment-referenced header SHALL NOT appear in the
recorded payload; only the reference name SHALL appear.

#### Scenario: Sent payload recorded with overrides applied

- **WHEN** a stage is delegated to a `model-endpoint` executor with a per-invocation model
  override and params
- **THEN** the recorded request payload SHALL show the overridden model and the transmitted
  params as sent

#### Scenario: Secrets absent from the recorded payload

- **WHEN** the invocation used a credential and an environment-referenced header
- **THEN** the recorded payload SHALL name the credential reference and the header reference
- **AND** SHALL NOT contain either resolved secret value

---

### Requirement: Response provenance SHALL be captured for every model-endpoint invocation

The pipeline SHALL capture, per `model-endpoint` invocation, the requested model, the model
the endpoint reports as resolved, the upstream provider the endpoint reports as having
served the request, the provider request id, the finish reason, token usage including cached
and reasoning tokens where reported, the provider-reported cost, retry and rate-limit
observations (retry count, rate-limit or retry-after signals encountered), and request
timing. Each field SHALL be read from the response body or response headers according to the
declared dialect. Captured provenance SHALL be attached to the stage's run evidence and
accounting record.

#### Scenario: OpenRouter-shaped response provenance captured

- **WHEN** an `openrouter`-dialect endpoint returns a response carrying a request id, a
  resolved model, an upstream provider, a finish reason, and usage including cost
- **THEN** the recorded provenance SHALL carry each of those values verbatim
- **AND** SHALL record the request timing

#### Scenario: Generic OpenAI-compatible response provenance captured

- **WHEN** a default-dialect OpenAI-compatible endpoint returns a response carrying an id, a
  model, a finish reason, and prompt/completion token counts
- **THEN** the recorded provenance SHALL carry the request id, resolved model, finish reason,
  and token usage
- **AND** SHALL record the request timing

#### Scenario: Retry and rate-limit observations recorded

- **WHEN** an invocation encounters a rate-limit or retry-after response before succeeding
- **THEN** the recorded provenance SHALL include the retry count and the rate-limit signal
  observed

---

### Requirement: Absent provider metadata SHALL be recorded as unknown and never inferred

Any provenance field the endpoint does not expose SHALL be recorded as `null`/unknown. The
pipeline SHALL NOT derive a resolved model, an upstream provider, or any other provenance
value from the model string, the `base_url` host, the executor name, or another provenance
field. A field recorded as unknown SHALL be distinguishable from a field the endpoint
reported as empty.

#### Scenario: Missing provider is null, not derived from the model name

- **WHEN** an endpoint returns a response with a model slug such as `openai/gpt-5` but no
  provider field
- **THEN** the recorded upstream provider SHALL be `null`
- **AND** SHALL NOT be populated from the model slug's prefix or from the endpoint host

#### Scenario: Missing usage and cost are unknown

- **WHEN** an endpoint returns a response with no usage object and no cost
- **THEN** the recorded token usage and cost SHALL be unknown rather than zero

---

### Requirement: Provider-reported cost SHALL reuse the existing cost classification

A provider-reported cost captured from a `model-endpoint` response SHALL be classified as an
**actual** cost under the existing stage-cost-accounting semantics. When no cost is reported,
the existing estimated-or-unknown classification SHALL apply unchanged. This change SHALL NOT
introduce a second cost model, a second cost field, or a separate API-only cost total.

#### Scenario: Reported cost classified as actual

- **WHEN** an endpoint reports a cost for the request
- **THEN** the stage accounting record SHALL carry that value with cost source `actual`

#### Scenario: No reported cost falls back to existing classification

- **WHEN** an endpoint reports no cost
- **THEN** the stage accounting record's cost source SHALL be `estimated` or `unknown`
  exactly as the existing classification decides, and no API-specific cost field SHALL be
  introduced

---

### Requirement: API endpoint executions SHALL be recorded with an execution class distinct from OAuth CLI harnesses

Every stage execution record SHALL carry an explicit execution/authentication class marking a
`model-endpoint` invocation as an API-key endpoint execution, distinct from the class
recorded for a subscription/OAuth local CLI harness execution. Readers SHALL NOT be required
to infer the class from the presence or absence of a `base_url`, an executor name, or any
other field. Experiment cell records for API treatments SHALL carry the same class, so an API
treatment and a CLI treatment are never aggregated as one population without that distinction
being visible.

#### Scenario: Model-endpoint execution marked as API class

- **WHEN** a stage is delegated to a `model-endpoint` executor
- **THEN** the stage accounting record SHALL carry an execution class identifying it as an
  API-key endpoint execution

#### Scenario: Local CLI execution keeps its own class

- **WHEN** a stage runs on a local CLI harness authenticated by subscription/OAuth
- **THEN** its record SHALL carry a distinct execution class, and SHALL NOT be marked as an
  API-key endpoint execution

#### Scenario: Class is explicit, not inferred

- **WHEN** an artifact reader groups executions by execution class
- **THEN** the class SHALL be read from the recorded field
- **AND** the reader SHALL NOT need to inspect `base_url`, provider, or executor name to
  determine it

---

### Requirement: New provenance fields SHALL be additive and version-tolerant

The provenance and execution-class fields added to stage accounting records SHALL be additive
and optional: no existing required field SHALL be added or removed, records written before
these fields existed SHALL remain readable, and a field SHALL be omitted or `null` rather
than written with a fabricated default. The accounting schema version SHALL be incremented,
and readers SHALL NOT gate behavior on the version equalling a specific value.

#### Scenario: Older records remain readable

- **WHEN** an artifact reader encounters a stage accounting record written before these
  fields existed
- **THEN** the reader SHALL accept the record and treat the new fields as unknown

#### Scenario: Absent provenance is omitted rather than defaulted

- **WHEN** an invocation produces no value for a provenance field
- **THEN** the record SHALL omit the field or set it to `null`
- **AND** SHALL NOT write a substituted or default value
