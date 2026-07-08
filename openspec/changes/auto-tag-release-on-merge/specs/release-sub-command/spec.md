# release-sub-command Specification

## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL open a release PR after human confirmation

After the ROADMAP diff is confirmed, the command SHALL:
1. Create a commit on a new branch `release/vX.Y.Z` containing the version bumps, mirror regen output, and ROADMAP update.
2. Open a PR via `gh pr create` with title `release: X.Y.Z — <theme>` and a body listing the included issues/PRs.
3. Print the PR URL on success.

The PR body SHALL include at minimum: the resolved version, the list of issues/PRs merged since the last release tag (with numbers and titles), and an instruction stating that **merging the PR is the final step** — it auto-creates the annotated `vX.Y.Z` tag and publishes the GitHub Release. The manual `git tag vX.Y.Z && git push origin vX.Y.Z` command SHALL still appear in the body but SHALL be labelled explicitly as a fallback (used only if the automation does not run), not as a required step.

#### Scenario: PR is opened with the correct title

- **WHEN** the release command completes successfully with version `1.6.0`
- **THEN** `gh pr view` for the created PR shows a title matching `release: 1.6.0 — <theme>`

#### Scenario: PR body lists issues/PRs since the last tag

- **WHEN** the PR is opened
- **THEN** the PR body contains a section listing each PR number and title included in the release

#### Scenario: PR URL is printed to stdout

- **WHEN** the PR is created successfully
- **THEN** the command prints the PR URL to stdout before exiting 0

#### Scenario: PR body describes merging as the final step with the tag command as a fallback

- **WHEN** the PR body is generated for version `1.6.0`
- **THEN** it states that merging the PR is the final step that auto-tags and publishes the release
- **AND** the `git tag v1.6.0 && git push origin v1.6.0` command is present but labelled as a fallback, not as a required post-merge action
