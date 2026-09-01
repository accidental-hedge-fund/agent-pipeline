## MODIFIED Requirements

### Requirement: Mutating implementation work SHALL refuse adapters that lack background_job_lifecycle

The pipeline SHALL refuse a local-CLI harness for product-mutating implementation work (implement, fix-round, test-fix, eval-fix, visual-fix) when the assigned adapter omits `background_job_lifecycle` or supplies a malformed required lifecycle declaration. The pipeline SHALL spawn that harness when the adapter declares `background_job_lifecycle.supported` as false. Explicit non-support SHALL mean the adapter cannot prove join. The lifecycle supervisor SHALL stay disabled for that invocation. The pipeline SHALL NOT invent lifecycle events for an unsupported adapter. Outer stage timeout and existing salvage SHALL still apply. When the adapter declares the capability supported under a coherent schema, the pipeline SHALL keep the join-grace watchdog. An omitted-field or malformed-declaration refusal SHALL be a typed `capability-refusal` distinguishable from missing-CLI, unauthenticated, unsupported model or effort, prompt-size refusal, signal termination, timeout, malformed harness output, and bare spawn errors. The refusal result SHALL carry `preflight_failed`, a structured `preflight_class`, `preflight_reason_code: capability-refusal`, intervention kind `auth-tooling-preflight-failure`, and a bounded actionable message. Planning and review invocations SHALL NOT require this capability and SHALL NOT be refused solely because the adapter declares `background_job_lifecycle` unsupported.

#### Scenario: Unsupported implementer is spawned without lifecycle supervision

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter that declares `background_job_lifecycle` unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the lifecycle supervisor SHALL stay disabled
- **AND** the pipeline SHALL NOT invent lifecycle events
- **AND** the pipeline SHALL spawn the harness CLI

#### Scenario: Omitted lifecycle declaration is refused before spawn

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter that omits `background_job_lifecycle`
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed `capability-refusal` naming the adapter and the missing capability
- **AND** the message SHALL state that retrying the same invocation cannot succeed without changing the adapter or the declaration
- **AND** the result SHALL set `preflight_failed` with `preflight_reason_code: capability-refusal` and intervention kind `auth-tooling-preflight-failure`

#### Scenario: Malformed required lifecycle declaration is refused before spawn

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter whose `background_job_lifecycle` object is malformed (supported is not boolean, or supported is true without a coherent schema)
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed `capability-refusal`
- **AND** the result SHALL set `preflight_failed` with `preflight_reason_code: capability-refusal`
- **AND** the bounded message SHALL name the adapter and the malformed field

#### Scenario: Planning and review still run on an unsupported adapter

- **WHEN** a planning or review stage assigns an adapter that declares `background_job_lifecycle` unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the stage SHALL proceed through the existing preflight path for that adapter

#### Scenario: Supported implementer is not refused by this check

- **WHEN** implementing assigns an adapter that declares `background_job_lifecycle` supported under a coherent schema and join grace
- **THEN** this capability check SHALL NOT refuse the invocation solely for that declaration

## ADDED Requirements

### Requirement: Mutating stages SHALL preserve typed production-preflight refusal on the stage outcome

The pipeline SHALL preserve a typed production-preflight refusal through the stage outcome of every mutating implementer stage (`implement`, `fix-1` / `fix-round`, `test-fix`, `eval-fix`, `visual-fix`). The outcome SHALL retain `preflight_failed`, `preflight_class`, `preflight_reason_code`, intervention kind, and the bounded actionable message. The pipeline SHALL NOT flatten that refusal to a bare `exit -1` reason. The pipeline SHALL NOT invent a harness session, SHALL NOT call `buildInvocation` for a model-consuming spawn, and SHALL NOT switch adapters. The same treatment SHALL NOT be retried as a crash. Existing crash and timeout retry behavior SHALL remain bounded and unchanged.

#### Scenario: Implement stage keeps typed fields instead of exit -1

- **WHEN** implementing receives a harness result with `preflight_failed: true` and `preflight_reason_code: capability-refusal`
- **THEN** the blocked stage outcome SHALL keep that reason code and intervention kind
- **AND** SHALL NOT classify the failure as `workflow-engine-defect` from `exit -1`
- **AND** SHALL record one stage-treatment invocation and zero harness sessions

#### Scenario: Eval-fix, visual-fix, and test-fix keep typed fields

- **WHEN** eval-fix, visual-fix, or test-fix receives a harness result with `preflight_failed: true`
- **THEN** the stage block reason SHALL include the typed preflight diagnostic
- **AND** SHALL NOT be only `exit -1`
- **AND** the stage SHALL NOT start another harness invocation for that same treatment

#### Scenario: Typed refusal stays distinct from other harness failures

- **WHEN** a mutating stage receives a typed production-preflight refusal
- **THEN** classification SHALL remain distinct from spawn error, signal termination, timeout, malformed harness output, and environment-auth
- **AND** SHALL NOT set those other flags as the primary class
