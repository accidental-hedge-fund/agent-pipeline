## MODIFIED Requirements

### Requirement: Deep preflight SHALL validate command path resolution and generator-owned allowed outputs

Deep preflight SHALL reject a fixture whose public or hidden check commands resolve to missing
paths under the cell worktree at the pin (including wrong test roots such as repository-root
`test/` when tests live under `core/test/`). When a fixture's public checks exercise packaging
freshness, preflight SHALL resolve the exact generator-owned outputs against the fixture's
`base_commit`. A historical pin MAY require an exact `plugin/` core-mirror output only when the
pinned `scripts/build.mjs` proves it generated that path. A post-#1048 pin SHALL require only the exact SKILL
overlay or marketplace catalog outputs made stale by the fixture's permitted generator inputs;
an ordinary `core/` edit SHALL NOT imply an unrelated SKILL or catalog output. When
`allowed_change_paths` is declared, it SHALL include each pin-resolved output or an explicit corpus
policy SHALL document why the output is omitted. Omission without policy SHALL fail preflight
naming the fixture and the missing output. A broad `plugin`, `plugin/`, `plugin/**`, or
`plugin/**/*` allowance SHALL fail this check at every pin.

#### Scenario: Unresolvable check path fails preflight

- **WHEN** a fixture public or hidden check references a path that does not exist at the pin in
  the cell worktree
- **THEN** preflight SHALL fail naming the fixture and the unresolved path

#### Scenario: Missing exact generated-output allowance fails when regeneration is required

- **WHEN** a fixture declares `allowed_change_paths` and its public checks require regenerating
  an exact generator-owned output at the fixture's `base_commit`
- **AND** the boundary omits that exact generated path without an explicit documented exception
- **THEN** preflight SHALL fail naming the fixture and the missing generator-owned output
- **AND** preflight SHALL NOT recommend or accept a broad `plugin/**` allowance

#### Scenario: Historical build pin requires its exact generated core-mirror path

- **WHEN** a fixture's pinned `scripts/build.mjs` copied an allowed `core/` source
  into a corresponding generated `plugin/` core-mirror path
- **THEN** preflight SHALL require that exact historical generated path
- **AND** SHALL NOT replace it with a current SKILL or catalog path that the pinned build did not
  generate from that source

#### Scenario: Current ordinary core edit does not require unrelated packaging output

- **WHEN** a post-#1048 fixture permits an ordinary `core/` source edit that is not an input to the
  generated SKILL overlay or marketplace catalog
- **AND** its public checks exercise packaging freshness
- **THEN** preflight SHALL NOT require either generated output solely because the edit is under
  `core/`

#### Scenario: Broad plugin allowance fails at every pin

- **WHEN** packaging freshness checks run and `allowed_change_paths` contains `plugin`, `plugin/`,
  `plugin/**`, or `plugin/**/*`
- **THEN** preflight SHALL fail naming the broad boundary
- **AND** remediation SHALL require only exact outputs generated at the fixture's `base_commit`
