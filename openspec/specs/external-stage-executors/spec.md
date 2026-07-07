# external-stage-executors Specification

## Purpose
TBD - created by archiving change external-stage-executors. Update Purpose after archive.
## Requirements
### Requirement: Named executor definitions in configuration

`PartialConfigSchema` SHALL accept an optional, strict `executors:` block that maps
each executor name to a definition with a required `type` of either
`agent-system` or `model-endpoint`. An `agent-system` definition SHALL reference an
external agent provider by a provider identifier and an API endpoint (not a local
CLI path). A `model-endpoint` definition SHALL declare a base URL and a model name.
An unknown key inside an executor definition, or an unknown `type`, SHALL be
rejected by strict schema validation. When the `executors:` block is absent, the
pipeline SHALL behave exactly as today.

#### Scenario: agent-system executor accepted

- **WHEN** `.github/pipeline.yml` sets `executors: { opencode-main: { type: agent-system, provider: opencode, endpoint: https://opencode.internal/api } }`
- **THEN** `resolveConfig()` SHALL accept it and expose a named executor `opencode-main` of type `agent-system` referencing that provider and endpoint

#### Scenario: model-endpoint executor accepted

- **WHEN** `.github/pipeline.yml` sets `executors: { local-ollama: { type: model-endpoint, base_url: http://localhost:11434/v1, model: llama3.1:70b } }`
- **THEN** `resolveConfig()` SHALL accept it and expose a named executor `local-ollama` of type `model-endpoint` with that base URL and model name

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

