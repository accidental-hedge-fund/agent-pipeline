## ADDED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit generator-owned plugin mirror paths

The fixture contract SHALL admit generator-owned `plugin/` mirror paths in an
`allowed_change_paths` boundary. When a fixture declares that boundary, paths under the
generated `plugin/` mirror that are produced by the repository's mirror generator for
corresponding `core/` edits SHALL be acceptable members of that boundary. Fixture validation
SHALL NOT reject a path solely because it lives under `plugin/`. The grading layer SHALL
treat a generator-owned `plugin/` path listed in the boundary as in-scope, the same as any
other listed path.

#### Scenario: Plugin mirror path listed in the boundary is accepted

- **WHEN** a fixture's `allowed_change_paths` includes a path under `plugin/` that mirrors a
  permitted `core/` edit
- **THEN** fixture validation SHALL succeed for that path
- **AND** a candidate change to that path SHALL NOT be counted as out of scope solely for living
  under `plugin/`

#### Scenario: Unlisted plugin paths remain out of scope when a boundary is declared

- **WHEN** a fixture declares an allowed-change boundary that does not include a given `plugin/`
  path and a candidate result modifies that path
- **THEN** the grading layer SHALL count that path as out of scope
