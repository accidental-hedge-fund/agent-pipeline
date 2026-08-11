# generated-changelog Specification

## Purpose
TBD - created by archiving change docs-generate-cli-config-reference. Update Purpose after archive.
## Requirements
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

---

### Requirement: Release tooling SHALL NOT reintroduce accreting ROADMAP Shipped history as the primary notes surface

The release preparation path (`pipeline release` / `stages/release.ts` ROADMAP mutations) SHALL NOT grow free-form "Shipped" prose or intro-chain history paragraphs in `ROADMAP.md` as the primary per-release notes surface after this change. New release historical detail SHALL land in `CHANGELOG.md` (via regenerate or bounded append). Compact release-plan table status cells (for example marking a plan row `✅ shipped`) MAY remain if they do not restate full release notes.

#### Scenario: Release path does not prepend a new Shipped prose block to ROADMAP

- **WHEN** release tooling prepares a release PR after this change
- **THEN** it SHALL NOT prepend a free-form multi-PR "Shipped" history block to `ROADMAP.md` as the primary notes surface
- **AND** the release's historical detail SHALL be reflected in `CHANGELOG.md` instead (regenerate or append)

#### Scenario: Compact plan-row shipped markers remain allowed

- **WHEN** release tooling marks a release-plan table row as shipped
- **THEN** a compact status update (for example `✅ shipped` and a short note) MAY be applied
- **AND** that update SHALL NOT reintroduce unbounded per-PR history prose into a Shipped section

### Requirement: Shipping a version tag SHALL refresh committed generator-owned CHANGELOG.md

When an annotated version tag `vX.Y.Z` is created as part of releasing this repository, the release completion path SHALL regenerate generator-owned docs (including `CHANGELOG.md`) from the structured release sources that include that tag, and SHALL commit any resulting generator dirt to the default branch. After that commit, a clean checkout of the resulting head with full history and tags available SHALL pass the docs generator check mode (`node scripts/generate-docs.mjs --check` or equivalent `docs:check`). The new version SHALL appear as a bounded per-version section in committed `CHANGELOG.md` (for example a `## [X.Y.Z]` heading produced by the generator). The release completion path SHALL NOT leave the default branch in a state where the next pull request fails docs freshness solely because the just-created tag is missing from committed `CHANGELOG.md`.

#### Scenario: Post-tag tree includes the new version section

- **WHEN** annotated tag `vX.Y.Z` has been created for a release and the release docs-refresh path has completed successfully
- **THEN** committed `CHANGELOG.md` on the default branch SHALL contain a bounded section for version `X.Y.Z`
- **AND** a clean full-history+tags checkout of that head SHALL exit 0 from the docs generator check mode

#### Scenario: No docs drift for the next PR from a missing just-shipped entry

- **WHEN** the post-tag docs-refresh path has completed for `vX.Y.Z`
- **AND** a subsequent pull request is opened against that default-branch head without further tag changes
- **THEN** the docs freshness gate SHALL NOT fail solely because `CHANGELOG.md` lacks the `X.Y.Z` section for that tag

#### Scenario: Idempotent when CHANGELOG already matches tags

- **WHEN** the post-tag docs-refresh path runs and a fresh generation produces no diff against committed generator-owned artifacts
- **THEN** the path SHALL succeed without creating an empty commit

#### Scenario: Refresh failure is visible after tag creation

- **WHEN** the version tag was created successfully
- **AND** docs regeneration or the docs commit/push fails
- **THEN** the release docs-refresh path SHALL fail closed with a non-zero outcome and diagnostics
- **AND** it SHALL NOT delete or rewrite the already-created version tag as rollback

---

### Requirement: Release CHANGELOG refresh tests SHALL inject tag inputs via a dependency seam

Unit or regression tests for the post-tag CHANGELOG refresh path SHALL inject tag/release list fixtures (or an equivalent generator input seam) and SHALL assert that the path regenerates and commits generator-owned docs when the injected inputs would make committed `CHANGELOG.md` stale. Those tests SHALL NOT require live network, live git, or live subprocess as the sole pass path.

#### Scenario: Injected new tag proves regenerate-and-commit

- **WHEN** a test injects a release list that includes a new version absent from the fixture committed CHANGELOG
- **AND** the post-tag refresh path runs under fake commit/write deps
- **THEN** the test SHALL observe a docs generate write and a commit request covering generator-owned paths (including `CHANGELOG.md`)
- **AND** the test SHALL fail if regenerate-and-commit is removed while the rest of the harness still passes

