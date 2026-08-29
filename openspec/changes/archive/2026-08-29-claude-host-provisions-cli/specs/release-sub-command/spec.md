## RENAMED Requirements

- FROM: ### Requirement: The `release` sub-command SHALL regenerate the `plugin/` mirror after bumping the version
- TO: ### Requirement: The `release` sub-command SHALL regenerate committed plugin packaging outputs after bumping the version

## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL regenerate committed plugin packaging outputs after bumping the version

After bumping both `package.json` files, the command SHALL run `node scripts/build.mjs` from the repo root to regenerate the declared packaging outputs: the plugin SKILL overlay, launcher scripts, plugin manifest, and marketplace catalog. The build SHALL NOT copy `core/scripts` into `plugin/`. If the build script exits non-zero, the command SHALL abort with a non-zero exit code and SHALL NOT proceed to the CI gate or the ROADMAP edit.

#### Scenario: Packaging outputs are regenerated before CI runs

- **WHEN** the version bump writes new `package.json` files
- **THEN** `node scripts/build.mjs` runs next, before `npm run ci`, ensuring the generated SKILL overlay and marketplace catalog are fresh when CI's `--check` runs

#### Scenario: Build failure aborts the release

- **WHEN** `node scripts/build.mjs` exits non-zero
- **THEN** the command SHALL exit non-zero, SHALL print the build output, and SHALL NOT proceed to the CI gate, ROADMAP edit, or PR creation

### Requirement: The `release` sub-command SHALL gate on `npm run ci` before opening a PR

After the version bump and packaging regeneration, the command SHALL run `npm run ci` from the repo root. If CI exits non-zero, the command SHALL abort with a non-zero exit code and SHALL NOT open a PR or create a commit.

#### Scenario: CI failure aborts before PR creation

- **WHEN** `npm run ci` exits non-zero
- **THEN** the command SHALL exit non-zero, SHALL print the CI output, and SHALL NOT write any git objects or call any GitHub API

#### Scenario: CI success proceeds to ROADMAP edit

- **WHEN** `npm run ci` exits 0
- **THEN** the command proceeds to scaffold and present the ROADMAP diff

### Requirement: Aborts before branch creation SHALL leave the working tree unchanged

The live release SHALL refuse to start if any release-managed path — `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, or `.claude-plugin/` — has uncommitted changes (tracked modifications or untracked files) when the command begins, failing fast with a non-zero exit before bumping the version, regenerating packaging outputs, or writing any file. This clean-tree precondition makes the rollback provably lossless.

Untracked-file detection SHALL be forced independent of the user's git configuration (i.e. it SHALL NOT rely on `status.showUntrackedFiles`), because abort rollback cleans untracked files from the release-managed `plugin/` and `.claude-plugin/` paths and would otherwise destroy an untracked file the guard failed to report. The packaging generator SHALL limit writes to its declared SKILL, launcher, material-filter, Node-resolver, manifest, and catalog paths. It MAY remove only the two wholly owned retired directories `plugin/pipeline/commands/` and `plugin/pipeline/skills/pipeline/core/`; unrelated files elsewhere under `plugin/` SHALL NOT be treated as generated output.

Any abort after the version bump and packaging regeneration but before the release branch is created — packaging-generation failure, CI failure, issue-discovery failure, or an editor abort — SHALL restore `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, and `.claude-plugin/` to their pre-release (HEAD) state and remove any untracked packaging debris generated during the run, so a retry reads the original `previousVersion` and is not poisoned by stranded version or generated-output changes. Because the precondition guaranteed these paths matched HEAD at the start, the rollback restores exactly the pre-release working tree and never discards a maintainer's pre-existing edits.

#### Scenario: A dirty release-managed path fails fast before any mutation

- **WHEN** any of `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, or `.claude-plugin/` has uncommitted changes at the start of a live release
- **THEN** the command SHALL exit non-zero naming the dirty paths and SHALL NOT bump the version, regenerate packaging outputs, or write any file
- **AND** because nothing was mutated, no rollback is performed (there is nothing to restore and nothing to discard)

#### Scenario: Untracked-file detection does not depend on user git config

- **WHEN** the clean-tree precondition checks the release-managed paths
- **THEN** it SHALL force untracked-file reporting (e.g. `git status --porcelain --untracked-files=all`) so an untracked file under `plugin/` is detected even when the maintainer has `status.showUntrackedFiles=no` configured

#### Scenario: post-bump abort rolls back the bumped files

- **WHEN** the command bumps the version, regenerates packaging outputs, then aborts (CI fails, issue discovery fails, or the editor aborts) before creating the release branch
- **THEN** `package.json` and `core/package.json` SHALL be restored to their pre-bump contents from HEAD
- **AND** the generated packaging outputs under `plugin/` and `.claude-plugin/` SHALL be restored to their pre-release state and any untracked build debris removed
- **AND** `ROADMAP.md` SHALL NOT be left in a stamped or partially-patched state
- **AND** because the clean-tree precondition held at the start, no pre-existing local edit in any release-managed path is discarded by the rollback

### Requirement: The `release` sub-command SHALL open a release PR after human confirmation

After the ROADMAP diff is confirmed, the command SHALL:
1. Stage only the release-managed paths `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, and `.claude-plugin/`, then create a commit on a new branch `release/vX.Y.Z` containing the version bumps, generated plugin packaging output, and ROADMAP update.
2. Open a PR via `gh pr create` with title `release: X.Y.Z — <theme>` and a body listing the included issues/PRs.
3. Print the PR URL on success.

The PR body SHALL include at minimum: the resolved version, the list of issues/PRs merged since the last release tag (with numbers and titles), and an instruction stating that **merging the PR is the final step** — it auto-creates the annotated `vX.Y.Z` tag and publishes the GitHub Release. The manual `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z` command SHALL still appear in the body but SHALL be labelled explicitly as a fallback (used only if the automation does not run), not as a required step. The fallback command SHALL create an **annotated** tag (`git tag -a`), never a lightweight tag, since `release.yml`'s annotated-tag guard rejects lightweight tags. The fallback note SHALL name the `RELEASE_TAG_TOKEN` repository secret the auto-tag workflow requires and its provisioning (a fine-grained PAT with `contents: read` + `contents: write` on the repository, added as a repository Actions secret), so a repo adopting the flow sees the setup requirement rather than a bare "missing credential" hint.

#### Scenario: PR is opened with the correct title

- **WHEN** the release command completes successfully with version `1.6.0`
- **THEN** `gh pr view` for the created PR shows a title matching `release: 1.6.0 — <theme>`

#### Scenario: PR body lists issues/PRs since the last tag

- **WHEN** the PR is opened
- **THEN** the PR body contains a section listing each PR number and title included in the release

#### Scenario: PR URL is printed to stdout

- **WHEN** the PR is created successfully
- **THEN** the command prints the PR URL to stdout before exiting 0

#### Scenario: Release commit stages both plugin packaging roots

- **WHEN** the release branch commit is prepared after packaging regeneration
- **THEN** the explicit staging paths SHALL include both `plugin/` and `.claude-plugin/`
- **AND** SHALL NOT include `.agent-pipeline/frg/`

#### Scenario: PR body describes merging as the final step with the tag command as a fallback

- **WHEN** the PR body is generated for version `1.6.0`
- **THEN** it states that merging the PR is the final step that auto-tags and publishes the release
- **AND** the `git tag -a v1.6.0 -m "..." && git push origin v1.6.0` command is present but labelled as a fallback, not as a required post-merge action

#### Scenario: PR body names the RELEASE_TAG_TOKEN provisioning requirement

- **WHEN** the PR body is generated
- **THEN** the fallback note names the `RELEASE_TAG_TOKEN` repository secret and its
  provisioning (a fine-grained PAT with `contents: read` + `contents: write` on the
  repository, added as a repository Actions secret) that the auto-tag workflow requires

### Requirement: The `release` sub-command SHALL refuse to run when `release_model` is `continuous`

When the resolved `config.roadmap.release_model` is `'continuous'`, the `pipeline release` sub-command SHALL exit non-zero before bumping the version, regenerating packaging outputs, or creating any git object or GitHub resource. It SHALL print a message stating that release bundling is unavailable under the `continuous` release model and naming the `roadmap.release_model` config key.

#### Scenario: Continuous model causes immediate refusal before any mutation

- **WHEN** the user runs `pipeline release minor` and the resolved config has `roadmap.release_model === 'continuous'`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL print a message naming `roadmap.release_model` and explaining that versioned release bundling is not available under the `continuous` model
- **AND** no version bump SHALL be written to any `package.json`
- **AND** no release branch, commit, or PR SHALL be created

#### Scenario: Semver model proceeds normally

- **WHEN** the user runs `pipeline release minor` and `config.roadmap.release_model` is `'semver'` or `release_model` is absent
- **THEN** the command SHALL proceed with the normal release flow without triggering the refusal gate

### Requirement: Release prepare SHALL remain invocable as a shared library for programmatic callers

The release prepare implementation used by `pipeline release` SHALL remain available as a shared in-process entry point (the existing `runRelease` function or an equivalent single-sourced API) so other explicit-authority CLI surfaces can invoke the same prepare path without reimplementing version bump, packaging regeneration, CI gate, ROADMAP scaffold, or pull-request creation. Programmatic callers SHALL be able to pass dry-run and non-interactive (`noEdit`) options equivalent to the CLI flags. A live non-interactive call SHALL still stop at an open release pull request. This requirement does not add tag, publish, or merge authority to the prepare path.

#### Scenario: Programmatic dry-run prepare performs no mutations

- **WHEN** a programmatic caller invokes the shared release prepare entry with dry-run enabled
- **THEN** the prepare path SHALL NOT write release-managed files
- **AND** it SHALL NOT open a release pull request
- **AND** it SHALL NOT create or push a tag

#### Scenario: Programmatic non-interactive prepare skips the editor

- **WHEN** an explicit-authority caller invokes the shared release prepare entry with non-interactive options
- **THEN** the prepare path SHALL NOT wait on `$EDITOR`
- **AND** on success it SHALL open a release pull request for separate operator finalization

### Requirement: The `release` sub-command SHALL fail closed on open candidate soak engine-class defects before version mutation

The live and dry-run `pipeline release` paths SHALL run the open-soak-defect preflight after version
resolution and after Factory Reliability Gate (FRG) evidence for the resolved version is available
(so soak identity can be read), and SHALL do so **before** bumping `package.json` files,
regenerating committed plugin packaging outputs, running `npm run ci`, editing `ROADMAP.md`, creating a release
branch, or opening a release PR. When the preflight returns a non-empty blocking set and no valid
audited override is supplied, the command SHALL exit non-zero with the preflight's doctor-grade
remediation and SHALL NOT mutate release-managed paths. This check is additive to the existing FRG
and `npm run ci` gates. It SHALL NOT merge any pull request and SHALL NOT create the release tag by
itself.

#### Scenario: Open soak defects abort before version bump

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** FRG pass evidence for `1.29.1` is available
- **AND** the open-soak-defect preflight returns at least one blocking open engine-class defect
- **AND** no valid override reason is supplied
- **THEN** the command SHALL exit non-zero listing the blocking issues
- **AND** SHALL NOT write `package.json`, `core/package.json`, or regenerate packaging outputs

#### Scenario: Clean open-defect set allows progression past the preflight

- **WHEN** FRG pass evidence is available for the resolved version
- **AND** the open-soak-defect preflight returns an empty blocking set
- **THEN** the open-soak-defect check SHALL not block the release path
- **AND** subsequent release steps MAY proceed as already specified

#### Scenario: Dry-run still evaluates open soak defects

- **WHEN** the user runs `pipeline release 1.29.1 --dry-run`
- **AND** open candidate-linked engine-class defects exist without a valid override
- **THEN** the dry-run SHALL report the block (non-zero or explicit would-block failure surface)
- **AND** SHALL NOT mutate release-managed paths

#### Scenario: Preflight does not auto-merge or auto-tag

- **WHEN** `pipeline release` evaluates the open-soak-defect preflight
- **THEN** it SHALL NOT merge the release PR as a side effect of that check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because the open-defect set is empty

### Requirement: Release prepare SHALL NOT be the sole writer of the shipped tag CHANGELOG entry

The prepare path (`pipeline release <version>`) SHALL continue to stop at an open release PR without merging, tagging, or publishing. Prepare MAY regenerate declared SKILL, launcher, manifest, and catalog outputs and other non-tag artifacts as today, but it SHALL NOT be relied on as the only mechanism that writes the generator-owned `CHANGELOG.md` section for the version being released. The shipped `## [X.Y.Z]` (or equivalent generator) entry for that version is the obligation of the post-tag docs-refresh path defined with auto-tag / release completion (see `generated-changelog` and `release-auto-tag-on-merge`), because the annotated tag that is the CHANGELOG source of truth does not exist until after the release merge.

#### Scenario: Prepare success without claiming post-tag CHANGELOG freshness

- **WHEN** `pipeline release 1.34.0` completes successfully and opens a release PR
- **THEN** the command SHALL still not merge, tag, or publish
- **AND** operators and automation SHALL treat tag-derived `CHANGELOG.md` freshness for `1.34.0` as incomplete until the post-tag docs-refresh path has run after `v1.34.0` exists

#### Scenario: Prepare does not gain tag authority to force CHANGELOG

- **WHEN** release prepare runs for version `X.Y.Z`
- **THEN** it SHALL NOT push annotated tag `vX.Y.Z` solely to regenerate CHANGELOG
- **AND** it SHALL NOT publish a GitHub Release

### Requirement: Live release prepare SHALL NOT stage Factory Reliability Gate evidence files

The live `pipeline release` path SHALL NOT pass `.agent-pipeline/frg` or any path under that tree as an explicit `git add` pathspec, including `git add -f`. This holds when a Factory Reliability Gate (FRG) pass artifact is present. On-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` SHALL remain the release-eligible lookup (`pass: true`, HMAC bound to the candidate SHA). Missing, unbound, `pass: false`, or unparsable evidence SHALL still fail-close. `--skip-frg` SHALL NOT be the product fix. The release commit SHALL contain living release-managed product files only (version bumps, ROADMAP, and generated plugin packaging outputs).

This requirement does not change HMAC or pack policy. It does not authorize committing `latest.json`.

#### Scenario: Gitignored FRG pass does not enter git add

- **WHEN** `.agent-pipeline/frg/` is gitignored
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is release-eligible (`pass: true`, HMAC bound to the candidate SHA)
- **AND** the operator runs `pipeline release 1.39.5 --no-edit`
- **THEN** the staging `git add` pathspec SHALL NOT include `.agent-pipeline/frg` or `.agent-pipeline/frg/1.39.5`
- **AND** the on-disk `latest.json` SHALL remain on disk
- **AND** the release commit SHALL NOT contain any `.agent-pipeline/frg/` path

#### Scenario: Missing on-disk latest.json still fail-closes

- **WHEN** `--skip-frg` is absent and `skip_frg` is unset or false
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` is missing
- **AND** the operator runs `pipeline release 1.39.5 --no-edit`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL NOT open a release pull request as a successful completion
- **AND** SHALL NOT treat `--skip-frg` as the remediation

#### Scenario: Unbound or failed HMAC still fail-closes

- **WHEN** `--skip-frg` is absent and `skip_frg` is unset or false
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` exists but is not release-eligible (`pass: false`, invalid HMAC, or HMAC not bound to the candidate SHA)
- **AND** the operator runs `pipeline release 1.39.5 --no-edit`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL NOT open a release pull request as a successful completion

#### Scenario: skipFrg still does not stage FRG

- **WHEN** the operator runs `pipeline release 1.39.5 --no-edit --skip-frg`
- **THEN** the staging `git add` pathspec SHALL NOT include `.agent-pipeline/frg` or any path under it
