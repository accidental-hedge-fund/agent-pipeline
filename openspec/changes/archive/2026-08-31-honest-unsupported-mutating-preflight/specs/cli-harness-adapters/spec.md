## MODIFIED Requirements

### Requirement: Mutating implementation work SHALL refuse adapters that lack background_job_lifecycle

The pipeline SHALL refuse a local-CLI harness for product-mutating implementation work (implement, fix-round, test-fix, eval-fix, visual-fix) when the assigned adapter omits `background_job_lifecycle`. The pipeline SHALL spawn that harness when the adapter declares `background_job_lifecycle.supported` as false. Explicit non-support SHALL mean the adapter cannot prove join. The lifecycle supervisor SHALL stay disabled for that invocation. The pipeline SHALL NOT invent lifecycle events for an unsupported adapter. Outer stage timeout and existing salvage SHALL still apply. When the adapter declares the capability supported under a coherent schema, the pipeline SHALL keep the join-grace watchdog. An omitted-field refusal SHALL be a typed `capability-refusal` distinguishable from missing-CLI, unauthenticated, unsupported model or effort, prompt-size refusal, and bare spawn errors. Planning and review invocations SHALL NOT require this capability and SHALL NOT be refused solely because the adapter declares `background_job_lifecycle` unsupported.

#### Scenario: Unsupported implementer is refused before spawn

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

#### Scenario: Planning and review still run on an unsupported adapter

- **WHEN** a planning or review stage assigns an adapter that declares `background_job_lifecycle` unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the stage SHALL proceed through the existing preflight path for that adapter

#### Scenario: Supported implementer is not refused by this check

- **WHEN** implementing assigns an adapter that declares `background_job_lifecycle` supported under a coherent schema and join grace
- **THEN** this capability check SHALL NOT refuse the invocation solely for that declaration
