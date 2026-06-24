## ADDED Requirements

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
