# release-auto-tag-on-merge Specification

## Purpose
TBD - created by archiving change auto-tag-release-on-merge. Update Purpose after archive.
## Requirements
### Requirement: An auto-tag workflow SHALL trigger on default-branch pushes

The repository SHALL provide a GitHub Actions workflow that triggers on `push` to the
default branch (`main`). This workflow SHALL be distinct from `release.yml`; it SHALL
NOT be triggered by tag pushes and SHALL NOT itself publish a GitHub Release.

#### Scenario: Workflow fires on a push to the default branch

- **WHEN** any commit is pushed to `main`
- **THEN** the auto-tag workflow is triggered

#### Scenario: Workflow does not publish releases itself

- **WHEN** the workflow YAML is inspected
- **THEN** it contains no `gh release create`/`gh release edit` step and no `push: tags`
  trigger — publishing remains solely `release.yml`'s responsibility, reached only via a
  `v*` tag push

---

### Requirement: The workflow SHALL detect a release merge by subject AND package version

The workflow SHALL treat the pushed HEAD commit as a release merge only when BOTH signals
hold: (1) the commit subject matches the `pipeline release` format `release: X.Y.Z — …`
(tolerating a trailing ` (#N)` from a squash merge), yielding a semver `X.Y.Z`; AND (2)
`core/package.json` at that commit has a `version` field exactly equal to that `X.Y.Z`.
When either signal is absent, the workflow SHALL exit as a successful no-op without
creating or pushing any tag.

#### Scenario: A genuine release merge is detected

- **WHEN** HEAD's subject is `release: 1.16.0 — Some theme (#412)` and `core/package.json`
  at HEAD has `"version": "1.16.0"`
- **THEN** the workflow proceeds to create and push the annotated tag `v1.16.0`

#### Scenario: A non-release merge is ignored

- **WHEN** HEAD's subject is `feat: add release notes tooling (#412)` (no `release: X.Y.Z`
  prefix)
- **THEN** the workflow exits a successful no-op and creates no tag

#### Scenario: Subject matches but the version does not — no tag

- **WHEN** HEAD's subject is `release: 1.16.0 — Some theme (#412)` but `core/package.json`
  at HEAD has `"version": "1.15.0"`
- **THEN** the workflow exits a successful no-op, logs the version mismatch, and creates
  no tag

---

### Requirement: The workflow SHALL create and push an annotated tag carrying release notes

On a detected release merge, the workflow SHALL create an **annotated** tag `vX.Y.Z`
(never a lightweight tag) pointing at the merge commit, with a message containing non-empty
release notes sourced from the merge-commit body, falling back to the release PR body when
the merge-commit body is empty or whitespace-only. If no non-empty notes can be resolved,
the workflow SHALL fail with a non-zero exit and SHALL NOT push a tag.

#### Scenario: Annotated tag is created with release notes

- **WHEN** a release merge for `1.16.0` is detected and the merge-commit body contains the
  release PR body
- **THEN** the workflow creates an annotated tag `v1.16.0` (object type `tag`, not `commit`)
  at the merge commit whose message equals those release notes, and pushes it to origin

#### Scenario: Notes fall back to the PR body when the merge body is empty

- **WHEN** the merge-commit body is empty or whitespace-only
- **THEN** the workflow resolves the release PR body via `gh` and uses it as the annotated
  tag message

#### Scenario: No resolvable notes fails loudly

- **WHEN** neither the merge-commit body nor the release PR body yields non-empty notes
- **THEN** the workflow exits non-zero and creates/pushes no tag

---

### Requirement: The pushed tag SHALL trigger the existing release workflow unchanged

The workflow SHALL push the annotated tag using a credential whose events trigger other
workflows, so that the resulting `v*` tag push runs the existing `release.yml` unchanged.
Because GitHub does not re-trigger workflows for events created by the default
`GITHUB_TOKEN`, the workflow SHALL NOT rely on `GITHUB_TOKEN` for the tag push; it SHALL
use a trigger-capable credential (a fine-grained PAT / GitHub App token with
`contents: write`, or a write-scoped SSH deploy key) supplied via a repository secret.

#### Scenario: Pushed tag runs release.yml

- **WHEN** the workflow pushes the annotated tag `v1.16.0`
- **THEN** the `v*` tag push triggers `release.yml`, which publishes the GitHub Release
  for `v1.16.0` using its existing (unchanged) annotated-tag guard and notes extraction

#### Scenario: Default GITHUB_TOKEN is not used for the tag push

- **WHEN** the workflow YAML is inspected
- **THEN** the tag push uses a repository-secret credential intended to trigger workflows,
  not the default `GITHUB_TOKEN`

---

### Requirement: The workflow SHALL be idempotent and never force-retag

Before creating the tag, the workflow SHALL check whether `vX.Y.Z` already exists on the
remote. If it exists, the workflow SHALL exit a successful no-op without creating, pushing,
force-updating, or deleting any tag. The workflow SHALL never force-push or delete a tag.

#### Scenario: Existing tag makes the workflow a no-op success

- **WHEN** a release merge for `1.16.0` is detected but `refs/tags/v1.16.0` already exists
  on the remote (a manual fallback push raced the automation)
- **THEN** the workflow exits 0 without creating, pushing, or force-updating any tag

#### Scenario: No force operations are present

- **WHEN** the workflow YAML is inspected
- **THEN** it contains no `git push --force`/`--force-with-lease` and no tag-delete step

---

### Requirement: The release merge-commit detection pattern SHALL be drift-guarded

The detection pattern used by the workflow SHALL be covered by a test that asserts it
matches the actual PR-title / squash-commit-subject format produced by `pipeline release`
(`release: X.Y.Z — <theme>` and its squash-merged form `release: X.Y.Z — <theme> (#N)`),
and does NOT match a plausible non-release subject. The test SHALL derive the pattern from
its single source (the workflow file) rather than re-declaring it, so a divergence between
the title format and the pattern fails the test.

#### Scenario: Pattern matches the real release title format

- **WHEN** the test builds a subject the same way `release.ts` builds the release PR title
  (e.g. `release: 1.16.0 — Factory reliability` and `release: 1.16.0 — Factory reliability (#412)`)
- **THEN** the workflow's detection pattern matches both and captures `1.16.0`

#### Scenario: Pattern rejects a non-release subject

- **WHEN** the test evaluates a plausible non-release subject (e.g. `feat: release tooling (#412)`)
- **THEN** the workflow's detection pattern does not match it

