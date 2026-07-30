# Provision RELEASE_TAG_TOKEN for auto-tag on release merge

## Why

Every release merge currently requires a **manual** annotated-tag push. The
`auto-tag-release` workflow is already in tree and deliberately refuses to fall
back to `GITHUB_TOKEN` (a tag pushed with it would not trigger `release.yml`),
but the `RELEASE_TAG_TOKEN` repository Actions secret has **never been
provisioned** on `accidental-hedge-fund/agent-pipeline`. Live evidence: Actions
secrets `total_count: 0`; releases including v1.15.1, v1.15.2, v1.28.3, and
v1.28.4 were hand-tagged. Without the secret, the tag-push step fails (or is
raced by the manual fallback) and the automated release path never completes.

## What Changes

- **Operator action only (no application code):** mint a fine-grained PAT with
  Contents read/write on this repository and store it as the repository Actions
  secret `RELEASE_TAG_TOKEN`.
- **Verify** the secret is listed on the repo and that the next release merge
  auto-creates the `vX.Y.Z` annotated tag and triggers `release.yml` without a
  manual tag push.
- **Document out-of-scope follow-up risk:** recent runs show release-notes
  resolution can fail *before* the tag-push step; that is a separate defect from
  missing credentials and is not fixed by this change.

## Acceptance Criteria

- [ ] `gh secret list -R accidental-hedge-fund/agent-pipeline` includes
      `RELEASE_TAG_TOKEN` (secret is present as a repository Actions secret).
- [ ] The PAT behind the secret is scoped to repository
      `accidental-hedge-fund/agent-pipeline` with **Contents: Read and write**
      (and no broader permissions than needed for tag push).
- [ ] On the next release-PR merge after the secret is set, the `auto-tag-release`
      workflow creates and pushes the annotated tag `vX.Y.Z` at the merge commit
      **without** a human `git tag` / manual tag push.
- [ ] That same `v*` tag push triggers `release.yml`, which completes successfully
      (publishes the GitHub Release for `vX.Y.Z`).
- [ ] No change to workflow YAML, engine code, or a `GITHUB_TOKEN` fallback is
      introduced by this change — behavior remains “secret required for tag push;
      never push with `GITHUB_TOKEN`.”

## Capabilities

### New Capabilities

<!-- None. This is operational provisioning for an existing workflow capability. -->

### Modified Capabilities

- `release-auto-tag-on-merge`: Add an operational requirement that the repository
  SHALL have `RELEASE_TAG_TOKEN` provisioned as a trigger-capable credential, so
  a detected release merge can complete the auto-tag path and fan out to
  `release.yml` without manual tagging.

## Impact

- **Repository configuration only:** Actions secret `RELEASE_TAG_TOKEN` on
  `accidental-hedge-fund/agent-pipeline`.
- **No code paths changed:** `.github/workflows/auto-tag-release.yml`,
  `release.yml`, `core/`, and `plugin/` are out of scope for edits.
- **Human-only minting:** fine-grained PAT creation has no stable API/CLI mint
  surface suitable for unattended automation; an org/repo admin must mint the
  token in the GitHub UI, then `gh secret set` stores it.
- **Downstream effect:** once provisioned, release merges stop depending on the
  manual tag fallback for the happy path (subject to other independent guards
  such as notes resolution).
- **Out of scope:** fixing empty release-notes resolution failures that abort
  before the tag-push step (observed on v1.28.3); fixing race/no-op when a
  manual tag lands first (v1.28.4); rotating or auditing other secrets; any
  auto-merge of release PRs.
