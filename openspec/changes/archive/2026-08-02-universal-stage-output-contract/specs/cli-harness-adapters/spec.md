## ADDED Requirements

### Requirement: Adapters SHALL expose a golden stage-output fixture hook without provider-branched validation

The local-CLI harness adapter layer SHALL support registration or discovery of golden response
shape fixtures for stage-output contracts so built-in and extension adapters can contribute
regression cases. Named Claude, Grok, and Codex shapes SHALL be fixtures only: production
validation SHALL NOT branch on adapter or provider name when accepting or rejecting product
output. Extension adapters SHALL be able to add fixtures for registered contract ids through
the documented hook or discovery path without forking the central stage-output validator.

Fixture registration shape SHALL remain alignable with the adapter capability / declaration
layer used for extension adapters so capability negotiation work (#738 / #783) can reference
the same adapter identity without inventing a second adapter namespace.

#### Scenario: Built-in adapters contribute golden fixtures as data

- **WHEN** golden stage-output fixtures for built-in adapters are loaded in tests
- **THEN** each fixture SHALL be associated with a registered contract id and expected
  validate outcome
- **AND** evaluation SHALL call the central contract validate function

#### Scenario: Extension adapter fixture uses the same validator

- **WHEN** an extension adapter registers a golden fixture for a registered contract id
- **THEN** the fixture SHALL be validated by the same central validate function as built-in
  fixtures
- **AND** production validation code SHALL NOT gain a branch on that extension adapter's name

#### Scenario: Provider name is absent from validation acceptance

- **WHEN** unit tests scan the stage-output validation path used after adapter normalization
- **THEN** acceptance of product shape SHALL NOT depend on reading the active harness name
- **AND** a regression test SHALL fail if such a dependency is introduced
