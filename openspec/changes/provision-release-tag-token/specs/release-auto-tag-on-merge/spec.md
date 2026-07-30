## ADDED Requirements

### Requirement: The repository SHALL provision RELEASE_TAG_TOKEN for auto-tag

The `accidental-hedge-fund/agent-pipeline` repository SHALL maintain a repository
Actions secret named `RELEASE_TAG_TOKEN` whose value is a trigger-capable
credential (fine-grained PAT or equivalent) with **Contents: Read and write** on
this repository. The secret SHALL be present so that a detected release merge can
reach the tag-push step with a non-empty token. Provisioning is an operator
configuration action; the workflow SHALL continue to refuse any fallback that
pushes the tag with the default `GITHUB_TOKEN`.

#### Scenario: Secret is listed on the repository

- **WHEN** an operator lists repository Actions secrets for
  `accidental-hedge-fund/agent-pipeline` (e.g. `gh secret list` or the Actions
  secrets API)
- **THEN** the list includes a secret named `RELEASE_TAG_TOKEN`

#### Scenario: Credential permissions are limited to tag-capable Contents access

- **WHEN** the credential behind `RELEASE_TAG_TOKEN` is inspected at mint time
- **THEN** it is restricted to repository `agent-pipeline` (or an equivalent
  single-repo binding) with Contents read and write sufficient to push an
  annotated tag, and is not a default `GITHUB_TOKEN`

---

### Requirement: A release merge with the secret provisioned SHALL auto-tag without manual tagging

The auto-tag workflow SHALL create and push the annotated tag `vX.Y.Z` at the
merge commit without a human `git tag` or manual tag push when
`RELEASE_TAG_TOKEN` is provisioned, a release merge is detected (subject and
package version match), notes resolve non-empty, and the tag does not already
exist. The resulting `v*` tag push SHALL trigger `release.yml`, which SHALL
publish the GitHub Release for that version using its existing path.

#### Scenario: Next release merge auto-tags via the workflow

- **WHEN** a release PR for version `X.Y.Z` is merged to `main` after
  `RELEASE_TAG_TOKEN` is provisioned, notes resolve non-empty, and no pre-existing
  `refs/tags/vX.Y.Z` is on the remote
- **THEN** the auto-tag workflow pushes annotated tag `vX.Y.Z` at the merge
  commit and no human manual tag push is required for that release

#### Scenario: Pushed auto-tag runs release.yml to completion

- **WHEN** the auto-tag workflow has pushed `vX.Y.Z` using `RELEASE_TAG_TOKEN`
- **THEN** `release.yml` is triggered by that tag push and completes successfully
  for `vX.Y.Z` (GitHub Release published)

#### Scenario: Manual tag remains only a fallback, not the primary path

- **WHEN** the secret is provisioned and auto-tag succeeds for a release merge
- **THEN** the release does not depend on a human annotated-tag command as the
  primary tagging mechanism (manual tagging remains only the documented emergency
  fallback if automation fails for an independent reason)
