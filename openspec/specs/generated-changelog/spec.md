# generated-changelog Specification

## Purpose
TBD - created by archiving change docs-generated-cli-config-reference. Update Purpose after archive.
## Requirements
### Requirement: Release history SHALL live in CHANGELOG.md rather than accreting ROADMAP Shipped prose

The repository SHALL maintain `CHANGELOG.md` as the operator-facing historical release surface. `ROADMAP.md` SHALL retain forward-looking planning content and SHALL NOT accrete a free-form "Shipped" prose paragraph for each new release. When a release ships, its historical detail SHALL appear as a bounded per-version entry in `CHANGELOG.md` (generated from git tags and/or GitHub Releases, or appended by release tooling), not as additional unbounded prose in `ROADMAP.md`.

#### Scenario: CHANGELOG.md exists as the history surface

- **WHEN** a reader wants per-version release history
- **THEN** `CHANGELOG.md` SHALL exist at the repository root (or a documented path linked from the README and ROADMAP)
- **AND** it SHALL contain bounded per-version sections for released tags

#### Scenario: ROADMAP no longer accretes Shipped prose

- **WHEN** `ROADMAP.md` is inspected after this change
- **THEN** it SHALL NOT contain an accreting free-form "Shipped" prose block that restates each release's full notes
- **AND** any pointer from ROADMAP to historical releases SHALL direct the reader to `CHANGELOG.md`

#### Scenario: Forward roadmap remains in ROADMAP.md

- **WHEN** a reader opens `ROADMAP.md`
- **THEN** the document SHALL still present forward-looking planning content (for example the forward roadmap narrative and/or release plan)

---

### Requirement: CHANGELOG content SHALL be derived from structured release sources

`CHANGELOG.md` SHALL be produced from structured sources — git tags and/or GitHub Release bodies — or by release tooling that appends a bounded entry at release time using those sources. The generation or append path SHALL be deterministic given the same tag/release inputs. Unit tests of the transform SHALL inject tag/release fixtures via a dependency seam and SHALL NOT require live network access.

#### Scenario: Generator or release tooling writes a bounded version section

- **WHEN** a version tag (and optional release body) is available to the changelog generator or release append path
- **THEN** `CHANGELOG.md` SHALL gain or refresh a single bounded section for that version rather than appending free-form prose to `ROADMAP.md`

#### Scenario: Unit tests do not call live GitHub

- **WHEN** the changelog transform unit tests run
- **THEN** they SHALL use injected fixtures for tags/release bodies
- **AND** they SHALL NOT perform real network, git, or subprocess calls for those assertions

---

### Requirement: Committed CHANGELOG artifacts SHALL be staleness-gated when generation is the maintenance path

When `CHANGELOG.md` is maintained by the docs generator (full regenerate from tags/releases), the docs generator check mode SHALL treat a stale committed `CHANGELOG.md` as a failure, consistent with other generated docs. When `CHANGELOG.md` is instead append-maintained only by release tooling, the check mode SHALL still verify any generator-owned portions, and release tooling SHALL be the only supported writer of new version sections.

#### Scenario: Generator-owned CHANGELOG fails check when stale

- **WHEN** `CHANGELOG.md` is generator-owned and differs from a fresh generation from the same tag/release inputs
- **THEN** the docs generator check mode SHALL exit non-zero

