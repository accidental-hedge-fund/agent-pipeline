## ADDED Requirements

### Requirement: Production harness invoke SHALL dispatch the exact resolved AdapterRequest through adapter preflight before buildInvocation or spawn

The production local-CLI harness invocation entry point SHALL, for every registered or
compatibility adapter, call that adapter’s `preflight` with the exact resolved model, effort, and
sandbox/tool policy that the subsequent `buildInvocation` will apply (together with role
eligibility for the stage’s role). Preflight SHALL use the pipeline’s injectable execution seam so
tests can prove the request without real subprocesses.

When preflight returns a failure, `invoke` SHALL return a failed harness result (or equivalent
structured failure) **without** calling `buildInvocation` for a model-consuming spawn and **without**
falling back to another adapter. When preflight succeeds, invocation construction and spawn MAY
proceed under existing capped-execution rules.

This requirement is additive to doctor and evals preflight call sites: production invoke SHALL not
rely on those sites having already run.

#### Scenario: Successful preflight proceeds to invocation construction

- **WHEN** production invoke is called with a resolved model and effort the adapter supports
- **AND** preflight returns ok
- **THEN** the pipeline MAY call `buildInvocation` and spawn under existing rules
- **AND** the preflight request SHALL have included that model and effort

#### Scenario: Failed preflight skips buildInvocation spawn path

- **WHEN** production invoke is called and adapter preflight returns not-ok for unsupported setting
  or missing CLI
- **THEN** the pipeline SHALL NOT spawn the harness CLI for that call
- **AND** SHALL NOT substitute a different adapter

#### Scenario: Injected-deps test observes exact resolved request

- **WHEN** a unit test injects a fake preflight and invokes production invoke for implementer and
  reviewer roles with distinct model/effort/sandbox values
- **THEN** the fake SHALL receive those exact values for each role
- **AND** no real subprocess SHALL be required to prove the contract

---

### Requirement: Adapter preflight and production invoke SHALL never silently drop unsupported settings

Production preflight SHALL refuse with an unsupported-setting (or role) failure when a stage or
caller requests a model, effort, sandbox mode, tool policy, or role that the adapter’s capabilities
or declaration mark unsupported. `buildInvocation` SHALL NOT be used as the sole enforcement point
by omitting flags while reporting success.

#### Scenario: Unsupported setting is refused rather than omitted

- **WHEN** production invoke is requested with sandbox or effort the adapter declares unsupported
- **THEN** preflight SHALL fail
- **AND** the resulting failure SHALL identify the unsupported setting
- **AND** a successful spawn with that setting silently omitted SHALL NOT occur
