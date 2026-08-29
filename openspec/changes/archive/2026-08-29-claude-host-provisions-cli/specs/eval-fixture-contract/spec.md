## REMOVED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit generator-owned plugin mirror paths

**Reason:** Issue #1048 retires generator-owned `plugin/` core-mirror paths. A broad exception for paths that mirror corresponding `core/` edits would preserve the dual-ship contract this change removes.

**Migration:** Fixtures may list exact generated SKILL overlay or marketplace catalog outputs. Listing a `core/` source path no longer admits an implicit `plugin/` counterpart.

## ADDED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit only explicitly listed generator-owned packaging outputs

The fixture contract SHALL permit fixtures to list exact generator-owned SKILL overlay or marketplace catalog
paths in an `allowed_change_paths` boundary. Fixture validation SHALL treat an explicitly
listed generated output as in scope, but SHALL NOT grant a broad `plugin/**` exception and
SHALL NOT admit a `plugin/` core-mirror path merely because a corresponding `core/` path was
edited.

#### Scenario: Exact generated output listed in the boundary is accepted

- **WHEN** a fixture's `allowed_change_paths` includes the generated Claude SKILL overlay or marketplace catalog
- **THEN** fixture validation SHALL succeed for that path
- **AND** a candidate change to that exact path SHALL NOT be counted as out of scope

#### Scenario: Unlisted plugin paths and retired core mirrors remain out of scope

- **WHEN** a fixture declares an allowed-change boundary that does not include a given `plugin/`
  path and a candidate result modifies that path
- **THEN** the grading layer SHALL count that path as out of scope
- **AND** listing a `core/` source path SHALL NOT implicitly admit a corresponding `plugin/` path
