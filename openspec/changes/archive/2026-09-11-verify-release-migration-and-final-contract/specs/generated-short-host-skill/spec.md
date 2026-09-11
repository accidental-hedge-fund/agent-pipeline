## ADDED Requirements

### Requirement: Generated host SKILL verb tables SHALL present the live release contract

The four generated host SKILL verb tables SHALL present independent `pipeline release` as direct-release and SemVer `pipeline ship --milestone` completion as ship-final-delegation. They SHALL NOT present historical optional-FRG, finish-as-tag-or-publish-owner, or ship-promotion as the live command contract. They SHALL NOT present install, promotion, or deployment as part of release or ship. Compact policy SHALL continue to map `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z` without a grant file.

#### Scenario: Host SKILL release row is direct-release

- **WHEN** a reader opens any of the four generated host SKILLs
- **THEN** the `release` verb row SHALL present independent complete SemVer release for an exact candidate
- **AND** it SHALL NOT present optional-FRG, finish, or ship-promotion as the live command

#### Scenario: Host SKILL ship row is ship-final-delegation

- **WHEN** a reader opens any of the four generated host SKILLs
- **THEN** the `ship` verb row SHALL present train then exactly one complete-release delegation
- **AND** it SHALL NOT present install, promotion, or deployment as part of that verb
