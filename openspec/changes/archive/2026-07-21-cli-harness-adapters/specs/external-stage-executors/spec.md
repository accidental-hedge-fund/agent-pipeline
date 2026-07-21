## MODIFIED Requirements

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

## ADDED Requirements

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
