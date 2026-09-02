## ADDED Requirements

### Requirement: The fault-recovery matrix host dimension SHALL reuse the outer-host conformance kit

The universal fault-recovery matrix host dimension SHALL evaluate builtin registered outer hosts and direct CLI through the existing outer-host conformance kit. Host rows SHALL compare typed lifecycle outcomes (verified success, Cooling, external-condition wait, typed request, cancellation). They SHALL NOT compare prompt text alone. Hermes and OpenClaw SHALL remain example-supervisor fixtures. Unsupported host capability SHALL be a typed Capability Request. This capability SHALL NOT add a second host table or a host-specific recovery recipe.

#### Scenario: Builtin hosts are scored by typed outcomes

- **WHEN** the matrix host layer runs against builtin registered outer hosts
- **THEN** each host SHALL be evaluated by the existing conformance kit
- **AND** a mechanical fixture SHALL yield the same unique-operation terminal class as direct CLI
- **AND** prompt-text equality SHALL NOT be the pass criterion

#### Scenario: Unsupported host capability is a typed request

- **WHEN** a host cannot launch a required supervised verb
- **THEN** that cell SHALL be a typed Capability Request or a checked `not_applicable` capability reason
- **AND** SHALL NOT become a False-human projection or ownerless terminal
