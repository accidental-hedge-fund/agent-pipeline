## ADDED Requirements

### Requirement: Extension adapters SHALL declare `maxPromptBytes` coherent with prompt delivery

Every registered extension adapter SHALL declare a `maxPromptBytes` delivery-channel limit (finite
positive integer, unlimited, or unknown) that is coherent with its declared prompt-delivery channel
and with the declaration’s prompt size/limit policy. Built-in, third-party package, and
custom-reviewer compatibility adapters all use this same generic field — not a vendor-specific
exception. The public contract vocabulary SHALL treat `maxPromptBytes` as that shared capability.

The shared conformance kit SHALL reject an extension adapter that:

- omits `maxPromptBytes`,
- declares prompt delivery and size/limit policy that disagree with `maxPromptBytes`, or
- claims unlimited on a positional/`argv` channel or a finite `MAX_ARG_STRLEN`-class ceiling on a
  stdin/file channel without matching declaration fields.

Machine-readable manifests and package-hook registrations SHALL be able to express the same three
limit classes so extension authors do not need a second, conflicting size field.

#### Scenario: Conformance rejects an extension missing maxPromptBytes

- **WHEN** the shared conformance kit evaluates a registered extension adapter that omits
  `maxPromptBytes`
- **THEN** the kit SHALL fail
- **AND** the failure SHALL name the missing field

#### Scenario: Conformance rejects channel and limit disagreement

- **WHEN** an extension adapter declares `argv` prompt delivery and unlimited `maxPromptBytes`
- **THEN** the shared conformance kit SHALL fail
- **AND** the failure SHALL identify the incoherent pair

#### Scenario: Compatibility custom-reviewer path declares a limit

- **WHEN** the custom-reviewer compatibility adapter is registered with default argv prompt delivery
- **THEN** it SHALL declare a finite `maxPromptBytes` consistent with the OS per-argument limit
- **AND** when configured for stdin prompt delivery it SHALL declare unlimited `maxPromptBytes`
  coherent with that channel
