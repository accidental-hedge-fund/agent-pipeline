## ADDED Requirements

### Requirement: Multi-change treatments MAY enable pre-code dossier and attestation when configured

Multi-change maintainability experiments that include a design-dossier / human-attestation treatment
variant SHALL activate that variant only when `#575` / `pre_code_attestation` controls are configured
and the risk policy fires for the fixture. Absence of `#575` configuration SHALL NOT prevent
bare-versus-pipeline execution. When activated, the treatment SHALL reuse the same benchmark
contract and deterministic verifiers as other treatments.

#### Scenario: unconfigured #575 does not block bare-vs-pipeline

- **WHEN** #575 design-dossier or human-attestation controls are not configured
- **THEN** a multi-change experiment that compares bare and pipeline treatments SHALL still execute
- **AND** SHALL NOT fail solely because pre-code attestation is absent

#### Scenario: configured triggered variant produces dossier materials

- **WHEN** a treatment profile enables pre-code attestation and the fixture risk policy fires
- **THEN** the treatment MAY require design-dossier / human-attestation materials under the pre-code attestation capability
- **AND** SHALL still emit the shared multi-change evidence contract fields
)
