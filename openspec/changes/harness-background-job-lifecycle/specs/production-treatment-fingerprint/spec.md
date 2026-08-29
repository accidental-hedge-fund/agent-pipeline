## ADDED Requirements

### Requirement: The capability hash SHALL include background_job_lifecycle

The stable capability hash derived from an adapter's declared capability and declaration surface
SHALL include the versioned `background_job_lifecycle` declaration (supported or unsupported,
schema version, and declared join grace when present). Two adapters that differ only in that
declaration SHALL NOT share a capability hash. Omitting the field from the hash payload SHALL
fail the fingerprint or conformance test that pins hash inputs.

#### Scenario: Support vs non-support changes the capability hash

- **WHEN** two otherwise identical adapter declarations differ only in
  `background_job_lifecycle` supported versus unsupported
- **THEN** their capability hashes SHALL differ

#### Scenario: Hash inputs include the lifecycle declaration

- **WHEN** the capability-hash payload used for production treatment identity is inspected under
  test
- **THEN** it SHALL include the `background_job_lifecycle` declaration fields
- **AND** a unit test SHALL fail if those fields are removed from the payload
