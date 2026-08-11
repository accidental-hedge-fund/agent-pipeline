## MODIFIED Requirements

### Requirement: Release history SHALL live in CHANGELOG.md rather than accreting ROADMAP Shipped prose

The repository SHALL maintain `CHANGELOG.md` as the operator-facing historical release surface. `ROADMAP.md`, when retained, SHALL present **derived or human-readable** forward-looking documentation only and SHALL NOT be the authoritative store for which issues are planned for a SemVer release — that authority is GitHub milestones (see `release-sub-command` and `roadmap-release-model`). `ROADMAP.md` SHALL NOT accrete a free-form "Shipped" prose paragraph for each new release. When a release ships, its historical detail SHALL appear as a bounded per-version entry in `CHANGELOG.md` (generated from git tags and/or GitHub Releases, or appended by release tooling), not as additional unbounded prose in `ROADMAP.md`.

#### Scenario: CHANGELOG.md exists as the history surface

- **WHEN** a reader wants per-version release history
- **THEN** `CHANGELOG.md` SHALL exist at the repository root (or a documented path linked from the README and ROADMAP)
- **AND** it SHALL contain bounded per-version sections for released tags

#### Scenario: ROADMAP no longer accretes Shipped prose

- **WHEN** `ROADMAP.md` is inspected after this change
- **THEN** it SHALL NOT contain an accreting free-form "Shipped" prose block that restates each release's full notes
- **AND** any pointer from ROADMAP to historical releases SHALL direct the reader to `CHANGELOG.md`

#### Scenario: ROADMAP is not release-plan authority

- **WHEN** a reader or tool needs the set of issues planned for a SemVer release version
- **THEN** GitHub milestone membership for that version SHALL be treated as authoritative
- **AND** `ROADMAP.md` SHALL NOT be described or used as the sole source of truth for that membership

#### Scenario: Forward roadmap remains in ROADMAP.md

- **WHEN** a reader opens `ROADMAP.md`
- **THEN** the document MAY still present human-readable forward-looking planning content
- **AND** any header or intro claim SHALL NOT call ROADMAP the release-plan source of truth in contradiction of milestone authority
