## MODIFIED Requirements

### Requirement: The pushed tag SHALL trigger the existing release workflow unchanged

The workflow SHALL push the annotated tag using a credential whose events trigger other
workflows, so that the resulting `v*` tag push runs the existing `release.yml` unchanged.
Because GitHub does not re-trigger workflows for events created by the default
`GITHUB_TOKEN`, the workflow SHALL NOT rely on `GITHUB_TOKEN` for the tag push; it SHALL
use a trigger-capable credential (a fine-grained PAT / GitHub App token with
`contents: write`, or a write-scoped SSH deploy key) supplied via the `RELEASE_TAG_TOKEN`
repository secret.

This trigger-capable credential SHALL be consumed ONLY by the tag-push step, never by
`actions/checkout`. `actions/checkout` SHALL use the default `GITHUB_TOKEN` (checkout,
history/tag fetch, version cross-check, and `git ls-remote` all work under the default
token). As a result, a push that is not a release merge — and any push while the secret
is unprovisioned — SHALL check out and conclude successfully without the secret being
evaluated. The workflow SHALL NOT fail a non-release push because `RELEASE_TAG_TOKEN` is
absent.

When a release merge IS detected but `RELEASE_TAG_TOKEN` is empty/absent, the tag-push
step SHALL fail with an explicit error that names `RELEASE_TAG_TOKEN` and states the
provisioning steps required (a fine-grained PAT with `contents: read` and `contents: write`
on this repository, added as a repository Actions secret named `RELEASE_TAG_TOKEN`) — it
SHALL NOT surface a generic `actions/checkout` "token required" error, and SHALL NOT fall
back to pushing the tag with `GITHUB_TOKEN` (which would leave `release.yml` untriggered).

#### Scenario: Pushed tag runs release.yml

- **WHEN** the workflow pushes the annotated tag `v1.16.0`
- **THEN** the `v*` tag push triggers `release.yml`, which publishes the GitHub Release
  for `v1.16.0` using its existing (unchanged) annotated-tag guard and notes extraction

#### Scenario: Default GITHUB_TOKEN is not used for the tag push

- **WHEN** the workflow YAML is inspected
- **THEN** the tag push uses the `RELEASE_TAG_TOKEN` repository-secret credential intended
  to trigger workflows, not the default `GITHUB_TOKEN`

#### Scenario: Checkout uses the default token and the secret is referenced only at tag push

- **WHEN** the workflow YAML is inspected
- **THEN** `actions/checkout` has no `token:` input referencing `RELEASE_TAG_TOKEN` (it
  uses the default `GITHUB_TOKEN`), and `RELEASE_TAG_TOKEN` is referenced only by the
  tag-push step

#### Scenario: A non-release push succeeds while the secret is absent

- **WHEN** a non-release commit is pushed to `main` and `RELEASE_TAG_TOKEN` is not
  provisioned
- **THEN** the workflow checks out under the default `GITHUB_TOKEN`, the detection guard
  no-ops before the tag-push step, and the run concludes successfully without evaluating
  `RELEASE_TAG_TOKEN`

#### Scenario: A release merge with the secret absent fails with an explicit provisioning error

- **WHEN** a release merge for `1.16.0` is detected (subject and `core/package.json`
  version both match) but `RELEASE_TAG_TOKEN` is empty/absent
- **THEN** the tag-push step exits non-zero with an error that names `RELEASE_TAG_TOKEN`
  and the provisioning steps (fine-grained PAT with `contents: read` + `contents: write`
  on this repository, added as a repository Actions secret), and no tag is pushed with
  `GITHUB_TOKEN`

## ADDED Requirements

### Requirement: The workflow's single point of secret use SHALL be drift-guarded

The auto-tag workflow's use of `RELEASE_TAG_TOKEN` SHALL be covered by a test that reads
the workflow YAML and asserts the secret is referenced ONLY by the tag-push step and is
NOT passed as the `token:` input to `actions/checkout`. The test SHALL bite: reintroducing
`token: ${{ secrets.RELEASE_TAG_TOKEN }}` on `actions/checkout` SHALL fail it, so the
checkout regression that failed every main push cannot silently return.

#### Scenario: Secret is confined to the tag-push step

- **WHEN** the test scans the workflow YAML for references to `RELEASE_TAG_TOKEN`
- **THEN** every reference is within the tag-push step and none appears on
  `actions/checkout`

#### Scenario: Reintroducing the secret at checkout fails the guard

- **WHEN** `token: ${{ secrets.RELEASE_TAG_TOKEN }}` is added to the `actions/checkout`
  step
- **THEN** the drift-guard test fails
