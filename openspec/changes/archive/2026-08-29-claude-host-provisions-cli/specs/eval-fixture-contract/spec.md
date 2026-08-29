## REMOVED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit generator-owned plugin mirror paths

**Reason:** Issue #1048 retires generator-owned `plugin/` core-mirror paths. A broad exception for paths that mirror corresponding `core/` edits would preserve the dual-ship contract this change removes.

**Migration:** Post-#1048 fixtures may list exact generated SKILL overlay or marketplace catalog outputs. Historical fixtures may retain an exact core-mirror output only when their pinned `scripts/build.mjs` proves it generated that path from an allowed source. Listing a `core/` source path never admits an implicit `plugin/` counterpart.

## ADDED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit only explicitly listed generator-owned packaging outputs

The fixture contract SHALL permit fixtures to list exact generator-owned packaging outputs in an
`allowed_change_paths` boundary. For a post-#1048 pin, those outputs are the generated SKILL overlay
or marketplace catalog. A historical fixture MAY list an exact `plugin/` core-mirror output only
when the pinned `scripts/build.mjs` at its `base_commit` proves it generated that path from an
allowed source.
Fixture validation SHALL treat such an explicitly listed, pin-resolved output as in scope, but
SHALL NOT grant a broad `plugin/**` exception and SHALL NOT admit a `plugin/` core-mirror path merely
because a corresponding `core/` path was edited.

#### Scenario: Exact current generated output listed in the boundary is accepted

- **WHEN** a fixture's `allowed_change_paths` includes the generated Claude SKILL overlay or marketplace catalog
- **THEN** fixture validation SHALL succeed for that path
- **AND** a candidate change to that exact path SHALL NOT be counted as out of scope

#### Scenario: Exact historical generated output is accepted only for its pin

- **WHEN** the fixture's pinned `scripts/build.mjs` proves it generated an exact `plugin/`
  core-mirror output from an allowed source
- **AND** `allowed_change_paths` lists that exact output
- **THEN** fixture validation SHALL accept that path for the historical fixture
- **AND** SHALL NOT infer any broader core-mirror allowance

#### Scenario: Unlisted plugin paths and retired core mirrors remain out of scope

- **WHEN** a fixture declares an allowed-change boundary that does not include a given `plugin/`
  path and a candidate result modifies that path
- **THEN** the grading layer SHALL count that path as out of scope
- **AND** listing a `core/` source path SHALL NOT implicitly admit a corresponding `plugin/` path
