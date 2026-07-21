## ADDED Requirements

### Requirement: Request controls SHALL NOT widen model-endpoint stage eligibility

The pipeline SHALL continue to permit a `model-endpoint` executor only on the
prompt-contained stages `plan-review`, `review-1`, and `review-2`, regardless of which
request controls, reasoning settings, structured-output settings, or headers that executor
declares. No combination of the new controls SHALL make a `model-endpoint` executor eligible
for an execution-environment stage; only an executor backed by a full agent system or a local
CLI adapter with repository and tool access SHALL be eligible for those stages. The rejection
SHALL remain a configuration-parse-time error naming both the offending stage and the
executor.

#### Scenario: Fully configured model-endpoint still rejected on an execution-environment stage

- **WHEN** `stage_executors: { implementing: openrouter-review }` and `openrouter-review` is a
  `model-endpoint` executor declaring a dialect, params, reasoning, headers, and structured
  output
- **THEN** `resolveConfig()` SHALL throw a parse error naming both `implementing` and
  `openrouter-review`
- **AND** the error SHALL be raised during configuration parsing, before any stage executes

#### Scenario: Controls do not change review-stage eligibility

- **WHEN** the same executor is assigned to `review-2`
- **THEN** `resolveConfig()` SHALL accept the assignment exactly as it does for a minimal
  `model-endpoint` executor

---

### Requirement: Documentation SHALL provide an OpenRouter example and state the prompt-contained restriction

The pipeline's user-facing documentation SHALL include a complete, working
`model-endpoint` executor example targeting OpenRouter — showing `base_url`, `model`,
`credential`, `dialect`, allowlisted `params`, extra headers by environment reference, and a
`stage_executors` assignment to a review stage — and SHALL state that `model-endpoint`
executors are restricted to prompt-contained stages together with the reason: a raw model
endpoint has no repository or tool access, so it cannot perform an execution-environment
stage.

#### Scenario: OpenRouter example present in documentation

- **WHEN** a reader consults the executor documentation
- **THEN** it SHALL contain an OpenRouter `model-endpoint` example including `base_url`,
  `model`, `credential`, `dialect`, `params`, headers, and a review-stage assignment

#### Scenario: Restriction and rationale documented

- **WHEN** a reader consults the same documentation
- **THEN** it SHALL state that `model-endpoint` executors may be assigned only to
  `plan-review`, `review-1`, and `review-2`
- **AND** SHALL give the reason that a raw model endpoint has no repository or tool access

---

### Requirement: Model-endpoint behavior SHALL be verified against provider-shaped responses without live API calls

The pipeline's tests SHALL exercise `model-endpoint` request construction and response
provenance extraction against both an OpenRouter-shaped response and a generic
OpenAI-compatible response, using the injected HTTP seam. The test suite and CI SHALL make no
live API call and no network call for these paths, and SHALL assert that no resolved
credential value or environment-referenced header value appears in emitted evidence.

#### Scenario: OpenRouter-shaped and generic responses both covered by injected-fake tests

- **WHEN** the test suite runs
- **THEN** it SHALL include a case feeding an OpenRouter-shaped response and a case feeding a
  generic OpenAI-compatible response through the injected HTTP seam
- **AND** SHALL assert the constructed request and the extracted provenance for each

#### Scenario: CI makes no live API call

- **WHEN** `npm run ci` runs
- **THEN** no `model-endpoint` test SHALL issue a real network request

#### Scenario: Secret redaction asserted by test

- **WHEN** a test invokes a `model-endpoint` executor configured with a credential and an
  environment-referenced header
- **THEN** the test SHALL assert that neither resolved value appears anywhere in the emitted
  evidence or accounting output
