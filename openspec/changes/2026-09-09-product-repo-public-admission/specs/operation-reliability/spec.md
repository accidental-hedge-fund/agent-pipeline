## MODIFIED Requirements

### Requirement: Public single, merge, and merge-queue persist SHALL land in the unique-operation collection dual-root

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue`, plus each merge admitted inside `pipeline train --merge`, SHALL persist and verify the recognizable run artifact in the approved persist root. When live factory-control identity matches this checkout, that root SHALL be the factory-control generic run store. Otherwise the working repository `repoDir` SHALL be the persist root. Product-repo `pipeline single`, `pipeline train`, `pipeline ship`, and `pipeline merge` SHALL NOT require `AGENT_PIPELINE_FACTORY_CONTROL` or a factory-control checkout. The stamp SHALL be bound to the admitted Logical Operation, physical attempt, exact entrypoint, repository, domain, and approved root. Persistence acknowledgement SHALL require atomic publication, durability flushes for the final files and containing directories, and exact read-back verification. An explicit empty persist-root overlay SHALL fail closed.

When any persistence or verification step fails, or the read-back identity conflicts with the pre-bound admission, the covered command SHALL fail closed before protected work starts. The failure SHALL retain the pre-bound Logical Operation and physical run identities in typed mechanical evidence owned by RecoverySupervisor. Collection SHALL NOT invent entrypoint coverage, success, completion, or authority from a partial or out-of-root artifact.

#### Scenario: Persist into the factory-control generic store is observed

- **WHEN** an operator admits `pipeline single 42` and the approved factory-control generic store is available
- **AND** the admission artifact is durably published and read-back verified there
- **THEN** in-flight ship unique-operation scoring SHALL observe `single`
- **AND** the child work SHALL retain the admitted Logical Operation identity

#### Scenario: Persist only into an empty overlay is not coverage

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **AND** the persist-root overlay is empty or null
- **THEN** admission SHALL fail before merge submission
- **AND** entrypoint coverage SHALL NOT observe `merge`
- **AND** the failure SHALL remain mechanically owned under the pre-bound identity

#### Scenario: Product-repo admission persists in the working repository

- **WHEN** an operator admits `pipeline single`, `pipeline train --merge`, `pipeline merge`, or `pipeline merge-queue --apply` from a product repository
- **AND** factory-control identity does not identify this checkout
- **THEN** admission SHALL persist in that repository's generic run store
- **AND** the protected command SHALL NOT be refused for missing factory-control setup

#### Scenario: Durability or read-back failure refuses protected work

- **WHEN** an injected create, temporary write, file flush, rename, final-file flush, directory flush, read-back, parse, or identity-verification step fails
- **THEN** the admission SHALL NOT be acknowledged
- **AND** no downstream supervised drive, merge, or merge-queue repair adapter SHALL run
