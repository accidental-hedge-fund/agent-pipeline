## ADDED Requirements

### Requirement: After creating a release version tag the auto-tag path SHALL refresh generator-owned docs

When the auto-tag workflow detects a genuine release merge and successfully creates and pushes annotated tag `vX.Y.Z`, it SHALL then run the repository docs generator in write mode (the same contract as `node scripts/generate-docs.mjs`) against a checkout that can observe that tag, and SHALL commit and push any resulting dirt in generator-owned artifacts (at minimum `CHANGELOG.md`) to the default branch. When generation produces no diff, the workflow SHALL NOT create an empty commit and SHALL still exit successfully for that step. When generation or the docs commit/push fails after the tag was pushed, the workflow job SHALL fail with non-zero status and SHALL NOT remove the tag as compensation.

#### Scenario: Successful tag then CHANGELOG commit

- **WHEN** the auto-tag workflow creates and pushes annotated tag `v1.34.0` for a detected release merge
- **AND** committed `CHANGELOG.md` on the default branch does not yet include the generator section for `1.34.0`
- **THEN** the workflow SHALL regenerate docs and push a non-empty commit that updates `CHANGELOG.md` (and any other generator-owned files dirtied by the same generate) so the `1.34.0` section is present

#### Scenario: No empty commit when already fresh

- **WHEN** the auto-tag workflow has pushed `vX.Y.Z`
- **AND** a fresh docs generation matches the committed generator-owned tree
- **THEN** the workflow SHALL NOT create an empty docs commit
- **AND** the job SHALL still succeed

#### Scenario: Docs refresh failure fails the job without deleting the tag

- **WHEN** the annotated version tag was pushed successfully
- **AND** the subsequent docs regenerate or docs commit/push fails
- **THEN** the workflow job SHALL exit non-zero
- **AND** the version tag SHALL remain on the remote

---

### Requirement: The post-tag docs commit SHALL NOT re-trigger release tagging

A default-branch push that exists only to commit regenerated generator-owned docs after a release tag SHALL NOT be treated as a new release merge. The auto-tag detection rules (release subject format AND matching `core/package.json` version) SHALL continue to no-op successfully for ordinary `docs:` (or equivalent) commit subjects so the docs-refresh commit cannot create another version tag or enter a tag loop.

#### Scenario: Docs regenerate commit is a successful no-op for tagging

- **WHEN** a commit whose subject does not match the release merge subject pattern is pushed to the default branch after post-tag docs refresh
- **THEN** the auto-tag workflow SHALL exit as a successful no-op
- **AND** SHALL NOT create or push a new version tag
