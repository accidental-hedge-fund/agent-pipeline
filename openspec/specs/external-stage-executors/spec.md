# external-stage-executors Specification

## Purpose
TBD - created by archiving change external-stage-executors. Update Purpose after archive.
## Requirements
### Requirement: Named executor definitions in configuration

`PartialConfigSchema` SHALL accept an optional, strict `executors:` block that maps
each executor name to a definition with a required `type` of `agent-system`,
`model-endpoint`, or `local-cli`. An `agent-system` definition SHALL reference an
external agent provider by a provider identifier and an API endpoint (not a local
CLI path). A `model-endpoint` definition SHALL declare a base URL and a model name.
A `local-cli` definition SHALL name a registered local harness adapter and MAY declare
an optional model and an optional reasoning effort for that assignment; it SHALL NOT
declare an endpoint, base URL, or credential reference, because it uses the operator's
already-authenticated local CLI. An unknown key inside an executor definition, an
unknown `type`, or a `local-cli` definition naming an adapter that is not registered
SHALL be rejected by strict schema validation at configuration-parse time, never
mid-run; the unregistered-adapter error SHALL name the offending value and list the
registered adapter names. When the `executors:` block is absent, the pipeline SHALL
behave exactly as today.

#### Scenario: agent-system executor accepted

- **WHEN** `.github/pipeline.yml` sets `executors: { opencode-main: { type: agent-system, provider: opencode, endpoint: https://opencode.internal/api } }`
- **THEN** `resolveConfig()` SHALL accept it and expose a named executor `opencode-main` of type `agent-system` referencing that provider and endpoint

#### Scenario: model-endpoint executor accepted

- **WHEN** `.github/pipeline.yml` sets `executors: { local-ollama: { type: model-endpoint, base_url: http://localhost:11434/v1, model: llama3.1:70b } }`
- **THEN** `resolveConfig()` SHALL accept it and expose a named executor `local-ollama` of type `model-endpoint` with that base URL and model name

#### Scenario: local-cli executor accepted

- **WHEN** `.github/pipeline.yml` sets `executors: { grok-impl: { type: local-cli, adapter: grok, model: grok-4, effort: high } }`
- **THEN** `resolveConfig()` SHALL accept it and expose a named executor `grok-impl` of type `local-cli` bound to the `grok` adapter with that model and effort

#### Scenario: local-cli executor naming an unregistered adapter is rejected at parse time

- **WHEN** `.github/pipeline.yml` sets `executors: { bogus: { type: local-cli, adapter: not-a-harness } }`
- **THEN** `resolveConfig()` SHALL throw a parse error naming `not-a-harness` and listing the registered adapter names
- **AND** the error SHALL be raised during configuration parsing, before any stage executes

#### Scenario: unknown executor type rejected

- **WHEN** `.github/pipeline.yml` sets an executor with `type: some-other-thing`
- **THEN** `resolveConfig()` SHALL throw a parse error identifying the invalid `type`

#### Scenario: no executors block — behavior unchanged

- **WHEN** `.github/pipeline.yml` contains no `executors:` block
- **THEN** every stage SHALL run through the existing local-CLI harness exactly as it does today, with no warning or behavior change

### Requirement: Per-stage executor assignment

`PartialConfigSchema` SHALL accept an optional, strict `stage_executors:` block
keyed by exact stage name, mapping each model-invoking stage — `planning`,
`implementing`, `review-1`, `review-2`, `fix-1`, `fix-2`, `plan-review`, and
`shipcheck-gate` when enabled — to a named executor independently. This is
stage-scoped, not role-scoped: there is no `role_executors:` key. A single run
SHALL be able to use different executors for different stages. A stage with no
assigned executor SHALL run through the existing local-CLI harness, unchanged.

#### Scenario: different executors for different stages in one run

- **WHEN** `.github/pipeline.yml` sets `stage_executors: { planning: opencode-main, review-1: local-ollama, review-2: local-ollama }`
- **THEN** the planning stage SHALL be delegated to `opencode-main` and the review rounds SHALL be delegated to `local-ollama` within the same run

#### Scenario: unassigned stage uses the local harness

- **WHEN** `stage_executors:` assigns only `review-1` and no executor is assigned to `implementing`
- **THEN** `implementing` SHALL run through the profile's implementer harness exactly as today

#### Scenario: agent-system executor valid for any model-invoking stage

- **WHEN** `stage_executors: { implementing: opencode-main }` and `opencode-main` is an `agent-system` executor
- **THEN** the assignment SHALL be accepted and `implementing` SHALL be delegated to that provider

### Requirement: Model-endpoint executors are restricted to prompt-contained stages

The pipeline SHALL permit a `model-endpoint`-type executor to be assigned only to
the prompt-contained stages `plan-review`, `review-1`, and `review-2`. Assigning a
`model-endpoint` executor to an execution-environment stage — `planning`,
`implementing`, `fix-1`, `fix-2`, or `shipcheck-gate` — SHALL be rejected at
config-parse time with an error naming both the offending stage and the executor.
This rejection SHALL occur during configuration parsing, never mid-run.

#### Scenario: model-endpoint on a review stage is allowed

- **WHEN** `stage_executors: { review-2: local-ollama }` and `local-ollama` is a `model-endpoint` executor
- **THEN** `resolveConfig()` SHALL accept the assignment

#### Scenario: model-endpoint on an execution-environment stage is rejected at parse time

- **WHEN** `stage_executors: { implementing: local-ollama }` and `local-ollama` is a `model-endpoint` executor
- **THEN** `resolveConfig()` SHALL throw a parse error that names both `implementing` and `local-ollama`
- **AND** the error SHALL be raised during configuration parsing, before any stage executes

#### Scenario: agent-system on an execution-environment stage is not rejected

- **WHEN** `stage_executors: { implementing: opencode-main }` and `opencode-main` is an `agent-system` executor
- **THEN** `resolveConfig()` SHALL NOT raise the model-endpoint stage-eligibility error for that assignment

### Requirement: Endpoint executor prompts SHALL be self-contained

For a stage delegated to a `model-endpoint` executor, the pipeline SHALL embed all
context the stage needs — plan text, PR diff, and a conventions excerpt as
applicable to that stage — directly in the prompt sent to the endpoint. The prompt
contract for `model-endpoint` executors SHALL NOT assume the executor can explore
the repository or invoke tools.

#### Scenario: review prompt to an endpoint carries the diff inline

- **WHEN** `review-2` is delegated to a `model-endpoint` executor
- **THEN** the prompt sent to the endpoint SHALL contain the PR diff (and the review context the stage needs) inline, rather than instructing the executor to read files from a worktree

#### Scenario: plan-review prompt to an endpoint carries the plan and conventions inline

- **WHEN** `plan-review` is delegated to a `model-endpoint` executor
- **THEN** the prompt sent to the endpoint SHALL contain the plan text and the conventions excerpt inline, rather than instructing the executor to read files from a worktree

### Requirement: Outcome contract is enforced independently of the executor

The pipeline SHALL enforce its stage outcome contract on the result returned by any
executor, regardless of which system produced it. For review stages this SHALL
include validating the returned result against the single-sourced JSON verdict
schema, exactly as for a local reviewer. The fix loops, review gates, and the
never-auto-merge stop SHALL behave identically whether a stage ran on a local
harness, an `agent-system` provider, or a `model-endpoint`.

#### Scenario: external reviewer verdict validated against the schema

- **WHEN** a review stage is delegated to an external executor and the executor returns a verdict
- **THEN** the pipeline SHALL parse and validate that verdict against the same JSON verdict schema used for local reviewers, and apply the same review-policy gating

#### Scenario: non-compliant verdict from an external reviewer does not pass the gate

- **WHEN** an external executor returns a result that does not satisfy the verdict schema
- **THEN** the pipeline SHALL treat it as a contract violation and SHALL NOT advance the item as if a valid verdict had been produced

#### Scenario: never-auto-merge preserved under external execution

- **WHEN** any combination of stages is delegated to external executors and all gates pass
- **THEN** the pipeline SHALL still stop at `pipeline:ready-to-deploy` and SHALL NOT merge

### Requirement: Provider credentials are referenced, never stored or emitted

The pipeline SHALL reference provider credentials by environment-variable name or
secret reference in configuration, and SHALL resolve the value from the environment
only at invocation time. Secret values SHALL NOT be stored in `pipeline.yml` and
SHALL NOT appear in run evidence or accounting output. A `model-endpoint` executor
that declares no credential (e.g. a localhost Ollama server) SHALL be valid with
none.

#### Scenario: credential referenced by env-var name

- **WHEN** an `agent-system` executor sets `credential: OPENCODE_API_KEY`
- **THEN** the pipeline SHALL read the key value from the `OPENCODE_API_KEY` environment variable at invocation time and SHALL NOT persist the value anywhere

#### Scenario: secret value never appears in evidence

- **WHEN** a stage is delegated to an executor that uses a credential reference
- **THEN** the emitted run evidence SHALL contain the credential reference name (or nothing), never the secret value

#### Scenario: endpoint with no credential is valid

- **WHEN** a `model-endpoint` executor for `http://localhost:11434/v1` declares no credential
- **THEN** `resolveConfig()` SHALL accept it and the stage SHALL be delegated with no credential

### Requirement: Misconfigured or unreachable providers fail before the stage runs, with no silent fallback

The pipeline SHALL validate a configured executor before the stage it is assigned to
executes. When the executor is misconfigured, unreachable, or its result does not
comply with the stage outcome contract, the pipeline SHALL block the run with an
error that names both the stage and the provider, and SHALL NOT silently fall back
to a local harness for that stage.

#### Scenario: unreachable provider blocks before execution

- **WHEN** an `agent-system` executor's endpoint is unreachable at the time its assigned stage would run
- **THEN** the pipeline SHALL block the item with an error naming the stage and the provider, before the stage's work begins

#### Scenario: no silent fallback to a local harness

- **WHEN** a configured executor for a stage fails preflight
- **THEN** the pipeline SHALL NOT run the stage on `claude` or `codex` as a silent substitute; it SHALL surface the failure
- **AND** this holds even for a review stage, where the pre-existing `review_harness` self-review fallback (#39) would otherwise apply to a missing reviewer CLI — a `stage_executors` assignment SHALL NOT route through that fallback path

### Requirement: Run evidence records the executor per stage

The pipeline SHALL record, in run evidence, which executor and provider ran each
delegated stage. For a `model-endpoint` executor, the record SHALL additionally
include the model name. Stages that ran on the local harness SHALL continue to be
recorded as today.

#### Scenario: agent-system execution recorded

- **WHEN** `planning` is delegated to the `opencode-main` `agent-system` executor
- **THEN** the run evidence for that stage SHALL record the executor name and the provider

#### Scenario: model-endpoint execution records the model name

- **WHEN** `review-1` is delegated to a `model-endpoint` executor running `llama3.1:70b`
- **THEN** the run evidence for that stage SHALL record the executor name, the endpoint/provider, and the model name `llama3.1:70b`

### Requirement: Local-CLI executors SHALL be assignable to every model-invoking stage

The pipeline SHALL permit a `local-cli`-type executor to be assigned to any model-invoking
stage, including the execution-environment stages `planning`, `implementing`, `fix-1`,
`fix-2`, and `shipcheck-gate`, because a local CLI adapter runs in the stage worktree and
has real repository and tool access. The `model-endpoint` execution-environment restriction
SHALL apply to `model-endpoint` executors only and SHALL NOT be extended to `local-cli`.

A single run SHALL be able to assign different `local-cli` executors — and therefore
different harness adapters — to different stages.

#### Scenario: local-cli executor on an execution-environment stage is accepted

- **WHEN** `stage_executors: { implementing: grok-impl }` and `grok-impl` is a `local-cli` executor
- **THEN** `resolveConfig()` SHALL accept the assignment
- **AND** SHALL NOT raise the model-endpoint stage-eligibility error for it

#### Scenario: different adapters on different stages in one run

- **WHEN** `stage_executors: { implementing: grok-impl, review-2: oc-review }` where `grok-impl` binds the `grok` adapter and `oc-review` binds the `opencode` adapter
- **THEN** the implementing stage SHALL run through the `grok` adapter and `review-2` SHALL run through the `opencode` adapter within the same run

### Requirement: Local-CLI executors SHALL preflight through their adapter rather than an HTTP probe

For a stage delegated to a `local-cli` executor, the before-stage preflight SHALL be that
adapter's own capability preflight — CLI presence, authentication state, headless
availability, and requested model/effort support — and SHALL NOT perform the endpoint
reachability probe used for `agent-system` and `model-endpoint` executors, which is
meaningless for a local CLI. A failing adapter preflight SHALL block the item with an error
naming both the stage and the adapter, with no fallback to another harness.

#### Scenario: local-cli preflight uses the adapter, not a network probe

- **WHEN** a stage is delegated to a `local-cli` executor
- **THEN** the before-stage preflight SHALL invoke that adapter's capability preflight
- **AND** SHALL NOT issue any network request for that executor

#### Scenario: failing local-cli preflight blocks the stage

- **WHEN** a `local-cli` executor's adapter preflight fails
- **THEN** the item SHALL be blocked with an error naming the stage and the adapter
- **AND** the stage SHALL NOT be executed on any other harness

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

