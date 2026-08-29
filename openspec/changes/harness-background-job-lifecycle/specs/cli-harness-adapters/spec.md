## ADDED Requirements

### Requirement: Every harness adapter SHALL declare background_job_lifecycle support or non-support

Every registered local-CLI harness adapter SHALL declare a versioned `background_job_lifecycle`
capability as either supported or unsupported. The declaration SHALL be part of the adapter's
capability and extension-declaration surface. Because the engine strips types rather than
checking them, the shared runtime conformance kit SHALL fail any registered adapter that omits
the declaration. A supported declaration SHALL name schema version
`pipeline/background-job-lifecycle@1` (or a later documented version) and MAY include a join
grace no larger than the pipeline-owned maximum. An unsupported declaration SHALL be explicit
boolean non-support, not an omitted field.

#### Scenario: Conformance requires an explicit declaration on every registered adapter

- **WHEN** the shared conformance kit evaluates the adapter registry
- **THEN** every registered adapter SHALL expose `background_job_lifecycle` as supported or
  unsupported
- **AND** an adapter missing the field SHALL fail the kit with a failure that names
  `background_job_lifecycle`

#### Scenario: Built-in adapters declare support or non-support explicitly

- **WHEN** the built-in `claude`, `codex`, `grok`, `pi`, and `opencode` adapters are inspected
- **THEN** each SHALL declare `background_job_lifecycle` supported or unsupported
- **AND** none SHALL omit the field
- **AND** an adapter whose raw protocol cannot prove lifecycle state SHALL declare unsupported

#### Scenario: Supported declarations cannot exceed the pipeline join maximum

- **WHEN** an adapter declares `background_job_lifecycle` supported with a join grace larger than
  the pipeline-owned versioned maximum
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL name the incoherent join grace

### Requirement: Mutating implementation work SHALL refuse adapters that lack background_job_lifecycle

Before spawning a local-CLI harness for product-mutating implementation work (implement,
fix-round, test-fix, eval-fix, visual-fix), the pipeline SHALL require the assigned adapter to
declare `background_job_lifecycle` supported. When the assigned adapter declares the capability
unsupported or omits it, the pipeline SHALL refuse the invocation before any child process is
spawned. The refusal SHALL be a typed `capability-refusal` distinguishable from missing-CLI,
unauthenticated, unsupported model or effort, prompt-size refusal, and bare spawn errors. Planning
and review invocations SHALL NOT require this capability and SHALL NOT be refused solely because
the adapter declares `background_job_lifecycle` unsupported.

#### Scenario: Unsupported implementer is refused before spawn

- **WHEN** implementing, fix-round, test-fix, eval-fix, or visual-fix assigns an adapter that
  declares `background_job_lifecycle` unsupported
- **THEN** the pipeline SHALL NOT spawn the harness CLI
- **AND** the result SHALL be a typed `capability-refusal` naming the adapter and the missing
  capability
- **AND** the message SHALL state that retrying the same invocation cannot succeed without
  changing the adapter or the declaration

#### Scenario: Planning and review still run on an unsupported adapter

- **WHEN** a planning or review stage assigns an adapter that declares `background_job_lifecycle`
  unsupported
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the stage SHALL proceed through the existing preflight path for that adapter

#### Scenario: Supported implementer is not refused by this check

- **WHEN** implementing assigns an adapter that declares `background_job_lifecycle` supported
  under a coherent schema and join grace
- **THEN** this capability check SHALL NOT refuse the invocation solely for that declaration
