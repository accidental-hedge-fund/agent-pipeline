## ADDED Requirements

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
