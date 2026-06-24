# release-workflow-annotated-notes Specification

## Purpose
TBD - created by archiving change release-yml-annotated-tag-notes. Update Purpose after archive.
## Requirements
### Requirement: The release workflow SHALL read the annotated tag message explicitly and pass it as the Release body

When a `v*` tag push triggers the release workflow, the workflow SHALL extract the tag annotation message using `git tag -l "$GITHUB_REF_NAME" --format='%(contents)'` and pass it to `gh release create` via `--notes-file`, rather than using `--notes-from-tag`.

#### Scenario: Annotated tag publishes Release with the annotation message as the body

- **WHEN** a maintainer pushes an annotated tag `vX.Y.Z` whose annotation message is `"v1.9.0 — My theme\n\nHighlights\n- ..."`
- **THEN** the GitHub Release created by the workflow has a body equal to that annotation message, with no additional auto-generated content

#### Scenario: Release body is not the squash-commit message

- **WHEN** a maintainer pushes an annotated tag `vX.Y.Z` whose squash-commit message differs from the annotation message
- **THEN** the published Release body matches the annotation message, not the commit message

---

### Requirement: The release workflow SHALL reject lightweight tags before publishing

Before extracting annotation notes or calling `gh release create`, the workflow SHALL check the tag object type using `git cat-file -t "$GITHUB_REF_NAME"`. If the type is `commit` (indicating a lightweight tag), the workflow SHALL exit non-zero with an error message naming the tag and SHALL NOT create a GitHub Release.

#### Scenario: Lightweight tag fails the workflow before publishing

- **WHEN** a maintainer pushes a lightweight tag `vX.Y.Z` (created with `git tag vX.Y.Z` rather than `git tag -a`)
- **THEN** the workflow step exits non-zero, the GitHub Actions job fails, and no GitHub Release is created for that tag

#### Scenario: Annotated tag passes the lightweight-tag guard

- **WHEN** a maintainer pushes an annotated tag `vX.Y.Z` (created with `git tag -a vX.Y.Z -m "..."`)
- **THEN** the lightweight-tag guard passes and the workflow proceeds to extract the annotation and publish the Release

---

### Requirement: The release workflow SHALL reject an empty annotation message before publishing

After extracting the annotation message and confirming the tag is annotated, the workflow SHALL verify the extracted notes are non-empty. If the notes file is empty, the workflow SHALL exit non-zero with a clear error and SHALL NOT publish a Release.

#### Scenario: Empty annotation aborts before publishing

- **WHEN** a maintainer pushes an annotated tag whose annotation message is empty or contains only whitespace
- **THEN** the workflow exits non-zero naming the tag and indicating that the annotation message is empty, and no GitHub Release is created

---

### Requirement: The release workflow SHALL re-fetch the annotated tag object before inspecting the tag

Before executing any tag-type guard or annotation-extraction step, the release workflow SHALL execute `git fetch origin --force "refs/tags/${GITHUB_REF_NAME}:refs/tags/${GITHUB_REF_NAME}"` to overwrite the runner's local tag ref with the real annotated tag object from the remote. This is required because `actions/checkout@v4` materializes the triggering tag ref peeled to its underlying commit, causing tag-type and annotation-content checks to fail even for genuine annotated tags.

#### Scenario: Annotated tag object is available after the fetch step

- **WHEN** an annotated tag `vX.Y.Z` triggers the workflow and the fetch step runs
- **THEN** `git cat-file -t "${GITHUB_REF_NAME}"` returns `tag` (not `commit`) and subsequent guard and extraction steps operate on the correct annotated tag object

#### Scenario: Fetch step does not affect lightweight-tag rejection

- **WHEN** a lightweight tag `vX.Y.Z` triggers the workflow and the fetch step runs
- **THEN** `git cat-file -t "${GITHUB_REF_NAME}"` still returns `commit` (the lightweight tag remains a commit pointer) and the annotated-tag guard rejects it as before

#### Scenario: Fetch step precedes all guards in the workflow step order

- **WHEN** the workflow YAML is inspected
- **THEN** the fetch step appears before the annotated-tag guard step and before the annotation-extraction step in the job's step list

