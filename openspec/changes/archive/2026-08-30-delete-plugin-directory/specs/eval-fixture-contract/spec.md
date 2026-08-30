## MODIFIED Requirements

### Requirement: A fixture allowed-change boundary SHALL admit only explicitly listed generator-owned packaging outputs

The fixture contract SHALL permit fixtures to list exact generator-owned
packaging outputs in an `allowed_change_paths` boundary. For a post-#1050 pin,
pin-resolved outputs MAY include the exact generated Claude, Codex, Grok, and
OpenCode host SKILL paths when the fixture's permitted generator inputs make
those paths stale. A historical fixture MAY list an exact `plugin/` path only when
the pinned `scripts/build.mjs` at its `base_commit` proves it generated that
path from an allowed source. Fixture validation SHALL treat an explicitly
listed, pin-resolved output as in scope, but SHALL NOT grant broad `hosts/**` or
`plugin/**` exceptions and SHALL NOT infer an output merely because some
unrelated `core/` path was edited. A current pin SHALL NOT require a plugin SKILL
overlay or a marketplace catalog that sources `plugin/`.

#### Scenario: Exact current generated output listed in the boundary is accepted

- **WHEN** a fixture's `allowed_change_paths` includes an exact generated host
  SKILL path that its pinned generator resolves from an allowed input
- **THEN** fixture validation SHALL succeed for that exact path
- **AND** a candidate change to that path SHALL NOT be counted as out of scope

#### Scenario: Exact historical generated output is accepted only for its pin

- **WHEN** the fixture's pinned `scripts/build.mjs` proves it generated an exact
  `plugin/` path from an allowed source
- **AND** `allowed_change_paths` lists that exact output
- **THEN** fixture validation SHALL accept that path for the historical fixture
- **AND** SHALL NOT infer any broader plugin allowance for current pins

#### Scenario: Unlisted plugin paths and retired core mirrors remain out of scope

- **WHEN** a fixture declares an allowed-change boundary that does not include a
  given generated host or `plugin/` path and a candidate result modifies that
  path
- **THEN** the grading layer SHALL count that path as out of scope
- **AND** listing a `core/` source path SHALL NOT implicitly admit an unrelated
  host SKILL, plugin path, or retired core mirror
