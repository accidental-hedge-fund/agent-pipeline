## ADDED Requirements

### Requirement: Stage accounting records SHALL capture harness-adapter provenance

A stage accounting record SHALL additively carry the treatment provenance of the invocation
that produced it: the harness adapter name, the adapter CLI's version when it reports one,
the provider/auth class when known, the requested model, the resolved model, the requested
reasoning effort, the resolved reasoning effort, whether the invocation was subject to a
provider fallback or throttling, the invocation duration, and the termination reason.

These fields SHALL be optional and additive: adding them SHALL NOT add or remove any
required field, records written before they existed SHALL remain readable, and a reader
SHALL treat an absent field as unknown rather than substituting a default. A value SHALL
NOT be fabricated — an unreported CLI version or provider SHALL be recorded as unknown or
omitted.

#### Scenario: An adapter invocation records full provenance

- **WHEN** a model-invoking stage runs through a harness adapter and reports its version and provider
- **THEN** the resulting stage accounting record SHALL carry the adapter name, CLI version,
  provider/auth class, requested and resolved model, requested and resolved effort,
  fallback/throttling status, duration, and termination reason

#### Scenario: Unreported provenance is recorded as unknown, not fabricated

- **WHEN** an adapter's CLI reports no version or no provider signal
- **THEN** the record SHALL omit those fields or record them as unknown
- **AND** it SHALL NOT record a substituted or inferred value

#### Scenario: Records written before these fields remain readable

- **WHEN** a reader processes a stage accounting record that predates the harness-provenance fields
- **THEN** the record SHALL parse successfully with every other field unchanged
- **AND** the reader SHALL treat the missing provenance as unknown

### Requirement: Recorded harness identity SHALL NOT be collapsed into provider identity

A stage accounting record SHALL keep the harness adapter name and the provider as separate
values. A record produced by a third-party harness adapter running against another vendor's
model SHALL name that adapter and that provider, and SHALL NOT name the vendor's own native
harness adapter. The provider SHALL NOT be derived from the model name.

#### Scenario: A third-party harness on another vendor's model keeps its own identity

- **WHEN** a stage runs through the `pi` or `opencode` adapter against an Anthropic model
- **THEN** the record's adapter field SHALL be `pi` or `opencode` respectively and its provider
  field SHALL be that provider
- **AND** neither field SHALL be recorded as `claude`

### Requirement: Harness provenance SHALL never include credential material

The provenance recorded for an adapter invocation SHALL contain no credential value, token,
account identifier, or auth file content. Only a coarse provider/auth class label SHALL be
recorded, and only when the CLI itself reports it.

#### Scenario: No credential material in an accounting record

- **WHEN** a stage accounting record produced by any adapter is inspected
- **THEN** it SHALL contain no credential value, token, account identifier, or auth file content
- **AND** at most a coarse provider/auth class label SHALL be present
