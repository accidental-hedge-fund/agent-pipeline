## ADDED Requirements

### Requirement: Ship-end composers SHALL spawn only after resolve-and-prepare

A ship-end composer (Tugboat, the installed `pipeline-ship-playbook` launcher, or in-engine `pipeline ship`) SHALL obtain the candidate-engine root for post-train `factory-release prepare`, `factory-gate`, `pipeline release`, `pipeline release finish`, and `pipeline release ensure-tag` from the shared resolve-and-prepare seam. Identity-only resolution SHALL NOT authorize those spawns. The composer SHALL fail closed before those verbs when resolve-and-prepare fails. The composer SHALL NOT fall back to the previous production-pin CLI because candidate runtime dependencies are missing.

#### Scenario: Missing candidate dependencies fail before ship-end spawn

- **WHEN** train is complete
- **AND** a candidate-engine root matches the FRG-bound SHA
- **AND** that root has no matching SHA-plus-lockfile-digest readiness record
- **AND** resolve-and-prepare cannot prove readiness
- **THEN** the composer SHALL fail the ship-end phase before spawning those verbs
- **AND** it SHALL NOT fall back to the previous production-pin CLI

#### Scenario: Prepared candidate is spawned

- **WHEN** train is complete
- **AND** resolve-and-prepare returns a runnable candidate root at SHA `C`
- **THEN** the composer SHALL invoke ship-end verbs on that root
- **AND** no ship-end candidate command SHALL have spawned before that return
