## ADDED Requirements

### Requirement: Generated CLI catalog SHALL present the live release contract

The generated `docs/cli.md` entry for `release` SHALL present independent `pipeline release VERSION` as direct-release: the complete SemVer contract for an exact candidate. The generated entry for `ship` SHALL present SemVer completion as ship-final-delegation to that independent release. Neither entry SHALL present historical optional-FRG, finish-as-tag-or-publish-owner, or ship-promotion as the live command contract. Explicit `release prepare` SHALL remain documented as the bounded metadata helper. If `release finish` remains listed, its summary SHALL identify it as a metadata-PR merge helper or as historical, and SHALL NOT describe it as the live complete-release command.

#### Scenario: Release catalog names direct-release

- **WHEN** `docs/cli.md` is generated from the current catalog
- **THEN** the `release` entry SHALL present `pipeline release VERSION` as the independently complete SemVer contract
- **AND** it SHALL NOT present optional-FRG, finish, or ship-promotion as the live complete-release command

#### Scenario: Ship catalog names ship-final-delegation

- **WHEN** `docs/cli.md` is generated from the current catalog
- **THEN** the `ship` entry SHALL present SemVer completion as exactly one delegation to independent release
- **AND** it SHALL NOT present install, promotion, or deployment as part of that command
