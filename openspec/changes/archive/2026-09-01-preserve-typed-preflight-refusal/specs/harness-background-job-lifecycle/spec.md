## ADDED Requirements

### Requirement: Production preflight SHALL refuse omitted or malformed required lifecycle and SHALL spawn explicit non-support

The pipeline SHALL treat an omitted or malformed required `background_job_lifecycle` declaration as a typed production-preflight `capability-refusal` for product-mutating implementation work. The pipeline SHALL NOT treat an explicit `supported: false` declaration as that refusal. Explicit non-support SHALL spawn the harness with the lifecycle supervisor disabled and SHALL NOT invent lifecycle events. When the adapter declares `supported: true` under a coherent schema, the pipeline SHALL keep the join-grace watchdog. This requirement SHALL NOT revert the #1364 compatibility contract.

#### Scenario: Explicit supported false remains spawn-allowed

- **WHEN** a mutating implementer stage assigns an adapter that declares `background_job_lifecycle.supported` as false
- **THEN** production preflight SHALL succeed this capability check
- **AND** the pipeline SHALL spawn the harness CLI
- **AND** the lifecycle supervisor SHALL stay disabled

#### Scenario: Omitted declaration remains capability-refusal

- **WHEN** a mutating implementer stage assigns an adapter that omits `background_job_lifecycle`
- **THEN** production preflight SHALL fail with `preflight_reason_code: capability-refusal`
- **AND** the pipeline SHALL NOT spawn the harness CLI

#### Scenario: Malformed declaration is capability-refusal

- **WHEN** a mutating implementer stage assigns an adapter whose `background_job_lifecycle` object fails the existing coherence contract
- **THEN** production preflight SHALL fail with `preflight_reason_code: capability-refusal`
- **AND** the pipeline SHALL NOT spawn the harness CLI
- **AND** the bounded message SHALL name the malformed field

#### Scenario: Supported true retains the watchdog

- **WHEN** a mutating implementer stage assigns an adapter that declares `background_job_lifecycle` supported under a coherent schema
- **THEN** this capability check SHALL NOT refuse the invocation
- **AND** the join-grace watchdog SHALL remain enabled for that invocation
