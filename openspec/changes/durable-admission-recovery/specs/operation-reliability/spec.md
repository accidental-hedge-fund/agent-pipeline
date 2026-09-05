## MODIFIED Requirements

### Requirement: Public single, merge, and merge-queue persist SHALL land in the unique-operation collection dual-root

Public-command admission of `pipeline single`, `pipeline merge`, and `pipeline merge-queue`, plus each merge admitted inside `pipeline train --merge`, SHALL persist and verify the recognizable run artifact in the approved control-host generic run store that unique-operation collection scores. The stamp SHALL be bound to the admitted Logical Operation, physical attempt, exact entrypoint, repository, domain, and approved root. Persistence acknowledgement SHALL require atomic publication, durability flushes for the final files and containing directories, and exact read-back verification. Persist SHALL NOT fall back to a candidate worktree or any root that the control-host authority has not approved.

When no approved control-host root is available, any persistence or verification step fails, or the read-back identity conflicts with the pre-bound admission, the covered command SHALL fail closed before protected work starts. The failure SHALL retain the pre-bound Logical Operation and physical run identities in typed mechanical evidence owned by RecoverySupervisor. Collection SHALL NOT invent entrypoint coverage, success, completion, or authority from a partial or out-of-root artifact.

#### Scenario: Persist into the factory-control generic store is observed

- **WHEN** an operator admits `pipeline single 42` and the approved factory-control generic store is available
- **AND** the admission artifact is durably published and read-back verified there
- **THEN** in-flight ship unique-operation scoring SHALL observe `single`
- **AND** the child work SHALL retain the admitted Logical Operation identity

#### Scenario: Persist only into a candidate worktree is not coverage

- **WHEN** an operator admits `pipeline merge` for a ready-to-deploy PR
- **AND** the only available persist target is a candidate-worktree run store that is not an approved collection root
- **THEN** admission SHALL fail before merge submission
- **AND** entrypoint coverage SHALL NOT observe `merge`
- **AND** the failure SHALL remain mechanically owned under the pre-bound identity

#### Scenario: Unknown factory-control root stays fail-closed

- **WHEN** an operator admits `pipeline merge-queue --apply`
- **AND** the approved control-host generic store cannot be resolved
- **THEN** admission SHALL return a typed persistence failure
- **AND** no merge, repair, or other protected apply side effect SHALL start
- **AND** missing required coverage SHALL remain a hard-gate failure

#### Scenario: Durability or read-back failure refuses protected work

- **WHEN** an injected create, temporary write, file flush, rename, final-file flush, directory flush, read-back, parse, or identity-verification step fails
- **THEN** the admission SHALL NOT be acknowledged
- **AND** no downstream supervised drive, merge, or merge-queue repair adapter SHALL run

## ADDED Requirements

### Requirement: Required-operation admission inventory SHALL cover every executable route

The pipeline SHALL maintain one executable inventory that maps every required public entrypoint to all production routes that can admit it, including direct dispatch, nested work, restart or resume, recovery re-entry, and each applicable generated host adapter. Inventory validation SHALL require set equality with the required-entrypoint set, reject duplicate and unknown records, and behaviorally prove that every declared route crosses the shared admission boundary with the expected root and identity. A declarative row or source-text match without an exercised route SHALL NOT satisfy the inventory.

#### Scenario: Resume route missing from inventory fails validation

- **WHEN** a required operation can resume through a production route that is absent from the admission inventory
- **THEN** the repository hard validation gate SHALL fail
- **AND** the failure SHALL name the missing operation and route

#### Scenario: Nested route bypassing shared admission fails validation

- **WHEN** a declared train-nested merge route reaches merge submission without an exercised shared admission stamp
- **THEN** the repository hard validation gate SHALL fail
- **AND** an inventory declaration alone SHALL NOT make the test pass

#### Scenario: Applicable host route preserves the CLI admission

- **WHEN** a generated Claude Code or Codex host adapter invokes a covered operation
- **THEN** it SHALL delegate to the same CLI admission path
- **AND** it SHALL NOT mint, rewrite, or bypass the CLI's Logical Operation identity or stamp

#### Scenario: Duplicate or unknown inventory member fails validation

- **WHEN** the inventory contains a duplicate route, an unknown entrypoint, or an entrypoint absent from the required set
- **THEN** the repository hard validation gate SHALL fail
- **AND** SHALL NOT silently normalize the invalid inventory
