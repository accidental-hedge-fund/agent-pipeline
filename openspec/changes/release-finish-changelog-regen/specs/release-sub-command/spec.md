## ADDED Requirements

### Requirement: Release prepare SHALL NOT be the sole writer of the shipped tag CHANGELOG entry

The prepare path (`pipeline release <version>`) SHALL continue to stop at an open release PR without merging, tagging, or publishing. Prepare MAY regenerate the `plugin/` mirror and other non-tag artifacts as today, but it SHALL NOT be relied on as the only mechanism that writes the generator-owned `CHANGELOG.md` section for the version being released. The shipped `## [X.Y.Z]` (or equivalent generator) entry for that version is the obligation of the post-tag docs-refresh path defined with auto-tag / release completion (see `generated-changelog` and `release-auto-tag-on-merge`), because the annotated tag that is the CHANGELOG source of truth does not exist until after the release merge.

#### Scenario: Prepare success without claiming post-tag CHANGELOG freshness

- **WHEN** `pipeline release 1.34.0` completes successfully and opens a release PR
- **THEN** the command SHALL still not merge, tag, or publish
- **AND** operators and automation SHALL treat tag-derived `CHANGELOG.md` freshness for `1.34.0` as incomplete until the post-tag docs-refresh path has run after `v1.34.0` exists

#### Scenario: Prepare does not gain tag authority to force CHANGELOG

- **WHEN** release prepare runs for version `X.Y.Z`
- **THEN** it SHALL NOT push annotated tag `vX.Y.Z` solely to regenerate CHANGELOG
- **AND** it SHALL NOT publish a GitHub Release

---

### Requirement: Release finish MAY heal docs after tag observation without owning tag creation

The operator-authorized `pipeline release finish <pr>` command SHALL continue to merge the release PR without itself creating tags or GitHub Releases. After a successful merge, finish MAY observe that annotated tag `vX.Y.Z` exists and invoke the same post-tag docs-refresh helper used by the auto-tag path when the local environment can write the default branch. When the auto-tag path has already committed an identical generator tree, finish's refresh SHALL be an idempotent no-op (no empty commit). Finish SHALL NOT delete tags, SHALL NOT publish releases, and SHALL NOT treat docs heal failure as a reason to unmerge the PR.

#### Scenario: Finish remains merge-authorized and tag-free

- **WHEN** `pipeline release finish <pr>` merges a valid release PR
- **THEN** the command SHALL NOT create or push the version tag
- **AND** tag creation SHALL remain the auto-tag workflow's responsibility

#### Scenario: Optional post-tag heal is idempotent

- **WHEN** finish observes tag `vX.Y.Z` after merge
- **AND** it invokes post-tag docs refresh
- **AND** committed generator-owned docs already match a fresh generation from current tags
- **THEN** finish SHALL succeed without creating an empty commit
