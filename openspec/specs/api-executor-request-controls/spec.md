# api-executor-request-controls Specification

## Purpose
TBD - created by archiving change api-executor-experiment-controls. Update Purpose after archive.
## Requirements
### Requirement: Model-endpoint definitions SHALL declare their wire dialect explicitly

A `model-endpoint` executor definition SHALL accept an optional `dialect` field whose
value is drawn from a closed, validated set (at minimum `openai` and `openrouter`),
defaulting to `openai` — a plain OpenAI-compatible `chat/completions` request — when
omitted. The declared dialect SHALL be the sole determinant of how reasoning/effort and
structured output are encoded on the wire and which response fields are read for
provenance. The pipeline SHALL NOT infer a dialect from the `base_url` host or from the
`model` string. An unrecognized `dialect` value SHALL be rejected at configuration-parse
time with an error naming the offending value and listing the supported values.

#### Scenario: Omitted dialect defaults to plain OpenAI-compatible

- **WHEN** a `model-endpoint` executor declares only `base_url` and `model`
- **THEN** `resolveConfig()` SHALL accept it with dialect `openai`
- **AND** the request sent for a delegated stage SHALL be the existing minimal
  `{model, messages}` payload with no added fields

#### Scenario: OpenRouter dialect accepted

- **WHEN** a `model-endpoint` executor declares `dialect: openrouter`
- **THEN** `resolveConfig()` SHALL accept it and record that dialect on the definition

#### Scenario: Unknown dialect rejected at parse time

- **WHEN** a `model-endpoint` executor declares `dialect: some-other-thing`
- **THEN** `resolveConfig()` SHALL throw a parse error naming `some-other-thing` and
  listing the supported dialect values
- **AND** the error SHALL be raised during configuration parsing, before any stage executes

#### Scenario: Dialect is never inferred from the model name

- **WHEN** a `model-endpoint` executor declares `model: openai/gpt-5` with no `dialect`
- **THEN** the effective dialect SHALL be the default `openai` dialect because it was not
  declared
- **AND** the pipeline SHALL NOT select a dialect on the basis of the model string or the
  `base_url` host

---

### Requirement: Model-endpoint definitions SHALL accept an allowlisted request-parameter block

A `model-endpoint` executor definition SHALL accept an optional strict `params` block
limited to an allowlisted set of request controls comprising at least `temperature`,
`top_p`, `seed`, `max_output_tokens`, `stop`, and dialect-supported provider/model routing
options (for the `openrouter` dialect, provider routing preferences and a model fallback
list). Allowlisted params SHALL be transmitted on the outbound request in the form the
declared dialect expects. Any key not in the allowlist, and any allowlisted key whose value
has the wrong type or is out of range, SHALL be rejected at configuration-parse time with
an error naming the offending key. A routing option declared for a dialect that does not
support it SHALL likewise be rejected at parse time, naming both the key and the dialect.
When `params` is absent, the outbound request SHALL be byte-identical to today's minimal
request.

#### Scenario: Allowlisted params are accepted and transmitted

- **WHEN** a `model-endpoint` executor declares `params: { temperature: 0, seed: 7, max_output_tokens: 4096 }`
- **THEN** `resolveConfig()` SHALL accept the block
- **AND** the outbound request for a delegated stage SHALL carry those controls in the
  declared dialect's field names

#### Scenario: Unknown param key rejected at parse time

- **WHEN** a `model-endpoint` executor declares `params: { temperatur: 0 }`
- **THEN** `resolveConfig()` SHALL throw a parse error naming `temperatur`
- **AND** the error SHALL be raised during configuration parsing, before any stage executes

#### Scenario: Provider routing options accepted for a supporting dialect

- **WHEN** a `model-endpoint` executor declares `dialect: openrouter` with provider routing
  preferences and a model fallback list in `params`
- **THEN** `resolveConfig()` SHALL accept them and the outbound request SHALL carry them in
  the OpenRouter-documented request fields

#### Scenario: Routing option rejected for a dialect that does not support it

- **WHEN** a `model-endpoint` executor declares the default `openai` dialect together with
  an OpenRouter-only routing option in `params`
- **THEN** `resolveConfig()` SHALL throw a parse error naming both the routing key and the
  declared dialect

#### Scenario: No params block leaves the request unchanged

- **WHEN** a `model-endpoint` executor declares no `params` block
- **THEN** the outbound request SHALL contain exactly the fields it contains today and no
  additional control fields

---

### Requirement: Reasoning effort SHALL be mapped by a provider-aware adapter and never silently dropped

The pipeline SHALL map a requested reasoning effort for a `model-endpoint` executor through
an adapter keyed on the declared dialect, producing exactly one of three outcomes: the
effort is **encoded** into the request in that dialect's form; the invocation **fails
preflight**; or the effort is **recorded as unsupported**. A dialect that can express
effort SHALL encode it (the `openrouter` dialect SHALL use its reasoning-effort request
field; the `openai` dialect SHALL use its reasoning-effort request field). When the declared
dialect cannot express the requested effort, the pipeline SHALL fail preflight by default
with an error naming the stage, the executor, the declared dialect, and the requested
effort, and SHALL NOT execute the stage. When, and only when, the definition explicitly
opts in to recording unsupported effort, the pipeline SHALL send the request without the
effort control and SHALL record the effort as unsupported with a null resolved effort. The
pipeline SHALL NOT send a request that omits a requested effort without either failing
preflight or recording it as unsupported.

#### Scenario: Effort encoded for a dialect that supports it

- **WHEN** a stage delegated to an `openrouter`-dialect `model-endpoint` executor requests
  effort `high`
- **THEN** the outbound request SHALL carry that effort in the OpenRouter reasoning-effort
  request field

#### Scenario: Unsupported effort fails preflight by default

- **WHEN** an effort is requested for a `model-endpoint` executor whose declared dialect
  cannot express reasoning effort and which has not opted in to recording it as unsupported
- **THEN** preflight SHALL fail with an error naming the stage, the executor, the dialect,
  and the requested effort
- **AND** the stage SHALL NOT be executed, and SHALL NOT fall back to a local harness

#### Scenario: Unsupported effort recorded when explicitly opted in

- **WHEN** the same executor explicitly opts in to recording unsupported effort
- **THEN** the request SHALL be sent without any effort control
- **AND** the run record SHALL mark the effort as unsupported with a null resolved effort

#### Scenario: Requested effort is never silently ignored

- **WHEN** any effort is requested for a `model-endpoint` executor
- **THEN** the resulting run record SHALL show either an encoded effort or an explicit
  unsupported marker, and SHALL never show an absent effort with no explanation

---

### Requirement: Model-endpoint definitions SHALL accept controlled extra headers by literal or environment reference

A `model-endpoint` executor definition SHALL accept an optional `headers` block whose values
are either a non-secret string literal or an environment-variable reference. Referenced
values SHALL be resolved from the environment at invocation time only. A header whose
environment reference is unset at preflight SHALL fail preflight with an error naming the
stage, the executor, the header name, and the referenced variable name, and SHALL NOT
execute the stage. A declared header SHALL NOT be permitted to override the credential
`Authorization` header or the `content-type` header; such a declaration SHALL be rejected at
configuration-parse time. The resolved value of an environment-referenced header, and the
resolved credential value, SHALL NOT appear in any run evidence, accounting record, log
line, or error message; only header names and reference names SHALL appear.

#### Scenario: Literal and referenced headers are both accepted

- **WHEN** a `model-endpoint` executor declares one literal header value and one
  environment-referenced header value
- **THEN** `resolveConfig()` SHALL accept the block
- **AND** the outbound request SHALL carry the literal value verbatim and the referenced
  variable's value resolved at invocation time

#### Scenario: Missing referenced environment variable fails preflight

- **WHEN** a declared header references an environment variable that is not set
- **THEN** preflight SHALL fail naming the stage, the executor, the header name, and the
  referenced variable name
- **AND** the stage SHALL NOT be executed

#### Scenario: Referenced header values never reach evidence

- **WHEN** a stage is delegated to a `model-endpoint` executor with an
  environment-referenced header
- **THEN** the emitted evidence SHALL contain the header name and the reference name
- **AND** SHALL NOT contain the resolved header value or the resolved credential value

#### Scenario: Overriding the credential or content-type header is rejected

- **WHEN** a `headers` block declares an `authorization` or `content-type` entry
- **THEN** `resolveConfig()` SHALL throw a parse error naming the offending header

---

### Requirement: Review stages MAY request structured output while verdict validation remains authoritative

A `model-endpoint` executor serving a prompt-contained review stage SHALL accept an optional
structured-output setting that, when enabled and supported by the declared dialect, adds
that dialect's JSON/JSON-schema response-format field to the outbound request. Enabling
structured output on a dialect that does not support it SHALL be rejected at
configuration-parse time naming the dialect. The structured-output request SHALL be a
transport hint only: the pipeline SHALL continue to parse and validate every returned
verdict against the single-sourced JSON verdict schema and SHALL apply the existing
`review_policy` gating unchanged, whether or not structured output was requested. A response
that fails verdict validation SHALL be treated as a contract violation exactly as it is
today, regardless of any provider-side schema guarantee.

#### Scenario: Structured output requested on a supporting dialect

- **WHEN** a review stage is delegated to a `model-endpoint` executor with structured output
  enabled on a dialect that supports it
- **THEN** the outbound request SHALL carry that dialect's response-format field constrained
  to the verdict schema

#### Scenario: Structured output on an unsupporting dialect rejected at parse time

- **WHEN** structured output is enabled for a dialect that does not support it
- **THEN** `resolveConfig()` SHALL throw a parse error naming the dialect

#### Scenario: Verdict validation is unchanged by structured output

- **WHEN** an endpoint returns a response with structured output enabled
- **THEN** the pipeline SHALL validate that response against the single-sourced verdict
  schema and apply `review_policy` gating exactly as for a response without structured
  output

#### Scenario: Non-compliant structured response still fails the gate

- **WHEN** an endpoint with structured output enabled returns a payload that does not
  satisfy the verdict schema
- **THEN** the pipeline SHALL treat it as a contract violation and SHALL NOT advance the
  item as if a valid verdict had been produced

---

### Requirement: Model-endpoint invocation SHALL accept per-invocation overrides without mutating committed configuration

The pipeline SHALL expose an invocation-time override seam through which a caller MAY
override a `model-endpoint` executor's `model`, allowlisted `params`, and requested effort
for a single invocation. The effective definition for that invocation SHALL be the committed
definition merged with the override, computed in memory. Applying an override SHALL NOT
write to `.github/pipeline.yml` or any other committed configuration file. Overrides SHALL
be validated against the same allowlist and dialect rules as committed configuration, and an
invalid override SHALL fail before the request is sent, naming the offending key. When no
override is supplied, the committed definition SHALL be used exactly as today.

#### Scenario: Model overridden for a single invocation

- **WHEN** an invocation supplies a model override for a `model-endpoint` executor
- **THEN** the outbound request SHALL carry the overridden model
- **AND** the committed configuration file SHALL be unmodified

#### Scenario: No override uses the committed definition

- **WHEN** an invocation supplies no override
- **THEN** the outbound request SHALL carry the committed `model` and committed `params`

#### Scenario: Invalid override rejected before the request is sent

- **WHEN** an invocation supplies an override containing a key outside the param allowlist
- **THEN** the invocation SHALL fail with an error naming the offending key
- **AND** no HTTP request SHALL be issued

#### Scenario: Concurrent overrides do not interfere

- **WHEN** two invocations of the same committed `model-endpoint` executor supply different
  model overrides
- **THEN** each request SHALL carry its own overridden model
- **AND** neither invocation SHALL observe the other's override

