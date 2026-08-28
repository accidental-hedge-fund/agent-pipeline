## ADDED Requirements

### Requirement: Init scaffold SHALL document trusted_audit_actors as audit-sentinel trust only
The init-scaffolded `.github/pipeline.yml` SHALL document `trusted_audit_actors` as a commented opt-in whose default is absence (only the current pipeline actor is trusted for audit sentinels). The documentation SHALL state that listed identities are trusted only to suppress audit-repair comments, SHALL carry a SECURITY note, and SHALL NOT present the key as override, merge, or finding-disposition authority. The documented example SHALL be schema-valid when uncommented.

#### Scenario: Scaffold documents trusted_audit_actors as commented opt-in
- **WHEN** `init` scaffolds `.github/pipeline.yml` in a repo with no existing config
- **THEN** the file SHALL contain a commented `trusted_audit_actors` example
- **AND** the documentation SHALL state that absence means only the current actor is trusted for audit sentinels
- **AND** the block SHALL include a SECURITY note

#### Scenario: trusted_audit_actors is not documented as override authority
- **WHEN** `init` scaffolds `.github/pipeline.yml`
- **THEN** the `trusted_audit_actors` documentation SHALL NOT claim that listed identities may dispose of review findings or grant override authority
- **AND** `trusted_override_actors` SHALL remain the documented grant for override sentinels

#### Scenario: Uncommenting trusted_audit_actors yields a schema-valid config
- **WHEN** an operator uncomments the documented `trusted_audit_actors` example in the scaffolded file
- **THEN** the resulting `.github/pipeline.yml` SHALL parse and validate via `resolveConfig` without error
