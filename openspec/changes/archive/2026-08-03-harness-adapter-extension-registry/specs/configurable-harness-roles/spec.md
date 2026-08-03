## ADDED Requirements

### Requirement: Harness role values SHALL resolve against the runtime registry and declared role capabilities

`harnesses.implementer` and `harnesses.reviewer` values SHALL resolve against the runtime adapter
registry rather than a fixed built-in name allowlist compiled into core. An implementer value
SHALL name an adapter that is registered and that declares the implementer role capability. A
reviewer value SHALL name either (a) a registered adapter that declares the reviewer role
capability, or (b) a custom-reviewer command that is materialized through the extension
compatibility path documented under `adapter-extension-registry` and
`configurable-review-harness`. Config validation messages that list valid adapters SHALL use the
runtime registry's current IDs.

#### Scenario: Extension adapter assigned as implementer

- **WHEN** a third-party adapter `ext-impl` is registered with the implementer role capability
- **AND** `.github/pipeline.yml` sets `harnesses: { implementer: ext-impl }`
- **THEN** `resolveConfig()` SHALL set the resolved implementer to `ext-impl`
- **AND** validation SHALL succeed without core source changes

#### Scenario: Extension adapter assigned as reviewer

- **WHEN** a third-party adapter `ext-rev` is registered with the reviewer role capability
- **AND** `.github/pipeline.yml` sets `harnesses: { reviewer: ext-rev }`
- **THEN** `resolveConfig()` SHALL set the resolved reviewer to `ext-rev`

#### Scenario: Unregistered implementer without compatibility path is rejected

- **WHEN** `harnesses.implementer` names a string that is not registered and is not accepted as an
  implementer via the documented compatibility rules
- **THEN** configuration resolution SHALL fail with a message naming the value
- **AND** the message SHALL list currently registered adapter IDs from the runtime registry

#### Scenario: Error messages list runtime registry IDs including extensions

- **WHEN** validation fails because an implementer name is unknown
- **AND** an extension adapter is registered in addition to built-ins
- **THEN** the error's registered-adapter list SHALL include the extension adapter ID
