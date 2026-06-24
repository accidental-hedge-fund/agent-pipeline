## Why

`actions/checkout@v4` materializes the triggering tag ref **peeled to its commit** on the runner, so `git cat-file -t "${GITHUB_REF_NAME}"` returns `commit` and trips the annotated-tag guard even when the remote tag object is genuinely annotated. The same root cause silences `git tag -l --format='%(contents)'`, producing empty notes and making the entire annotated-tag → Release-body pipeline non-functional. v1.9.0 was the first release to hit this; it had to be published manually.

## What Changes

- `.github/workflows/release.yml`: add a single step before the annotated-tag guard that explicitly re-fetches the real tag object from origin (`git fetch origin --force "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"`), overwriting checkout's peeled local ref. No other workflow steps change.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `release-workflow-annotated-notes`: the workflow SHALL ensure the local tag ref reflects the annotated tag object before executing any guards or extracting notes. This is a new prerequisite step; the existing requirements (reject lightweight tags, reject empty notes, publish Release body from annotation) are unchanged in intent but were non-functional without it.

## Impact

- `.github/workflows/release.yml` — one new step added before the annotated-tag guard.
- No changes to `core/`, `plugin/`, scripts, or tests (this is a CI-workflow-only fix).

## Acceptance Criteria

- [ ] A workflow run triggered by pushing a genuine annotated `v*` tag passes the annotated-tag guard and publishes a GitHub Release whose body equals the tag annotation message.
- [ ] A workflow run triggered by a lightweight `v*` tag still fails the annotated-tag guard with a clear error before creating a Release.
- [ ] A workflow run for an annotated tag with an empty/whitespace-only annotation still fails the empty-notes guard before creating a Release.
- [ ] A workflow run for a tag whose name does not match `package.json` version still fails the version-match guard.
- [ ] The Release body is the tag annotation (not the squash-commit message and not auto-generated notes).
- [ ] The fix is a single targeted `git fetch` step; no other workflow steps are modified.
