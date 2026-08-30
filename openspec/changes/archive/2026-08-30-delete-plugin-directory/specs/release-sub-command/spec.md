## RENAMED Requirements

- FROM: ### Requirement: The `release` sub-command SHALL regenerate committed plugin packaging outputs after bumping the version
- TO: ### Requirement: The `release` sub-command SHALL regenerate committed host SKILL outputs after bumping the version

## MODIFIED Requirements

### Requirement: The `release` sub-command SHALL regenerate committed host SKILL outputs after bumping the version

After bumping both `package.json` files, the command SHALL run `node scripts/build.mjs` from the repo root to regenerate the declared packaging outputs: the four generated host SKILLs. The build SHALL NOT write any path under `plugin/`. If the build script exits non-zero, the command SHALL abort with a non-zero exit code and SHALL NOT proceed to the CI gate or the ROADMAP edit.

#### Scenario: Packaging outputs are regenerated before CI runs

- **WHEN** the version bump writes new `package.json` files
- **THEN** `node scripts/build.mjs` runs next, before `npm run ci`, ensuring the generated host SKILLs are fresh when CI's `--check` runs

#### Scenario: Build failure aborts the release

- **WHEN** `node scripts/build.mjs` exits non-zero
- **THEN** the command SHALL exit non-zero, SHALL print the build output, and SHALL NOT proceed to the CI gate, ROADMAP edit, or PR creation

#### Scenario: Release generate does not recreate plugin/

- **WHEN** the release path runs `node scripts/build.mjs` after the version bump
- **THEN** the generator SHALL NOT create a `plugin/` directory
- **AND** SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`

### Requirement: Aborts before branch creation SHALL leave the working tree unchanged

The live release SHALL refuse to start if any release-managed path has tracked
or untracked changes. The managed set SHALL include `package.json`,
`core/package.json`, `ROADMAP.md`, and the exact
generated host paths `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`,
`hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md`. The managed set SHALL NOT
include `plugin/`. `.claude-plugin/` SHALL be managed only when that catalog
file remains a generated output; after the catalog is retired it SHALL NOT be
a release-managed path. This precondition SHALL
run before version mutation or `node scripts/build.mjs`, because that generator
owns the four host SKILLs.

Untracked-file detection SHALL remain independent of user git configuration.
The packaging generator SHALL write only its declared exact host SKILL outputs.
It SHALL NOT create or remove paths under `plugin/`.

Any abort after version bump and generation but before release-branch creation
SHALL restore every release-managed path, including the four generated host
SKILLs, to its pre-release `HEAD` state and remove only untracked debris at
declared generator-owned paths. Because the clean precondition covered every
path the generator can mutate, rollback SHALL remain lossless and SHALL NOT
discard a maintainer's pre-existing edit. Rollback SHALL NOT recreate a
`plugin/` tree.

#### Scenario: A dirty release-managed path fails fast before any mutation

- **WHEN** any package, ROADMAP, or exact generated host SKILL
  path in the release-managed set has tracked or untracked changes at live
  release start
- **THEN** the command SHALL exit non-zero naming the dirty exact paths and
  SHALL NOT bump the version, regenerate packaging outputs, or write any file
- **AND** because nothing was mutated, no rollback is performed

#### Scenario: Untracked-file detection does not depend on user git config

- **WHEN** the clean-tree precondition checks every release-managed path
- **THEN** it SHALL force untracked-file reporting (for example
  `git status --porcelain --untracked-files=all`) so untracked
  exact generated host SKILL debris is detected even when
  `status.showUntrackedFiles=no`

#### Scenario: post-bump abort rolls back the bumped files

- **WHEN** the command bumps the version, regenerates packaging outputs, then
  aborts before creating the release branch
- **THEN** `package.json`, `core/package.json`, `ROADMAP.md`,
  and all four exact generated host SKILLs SHALL be restored
  to their pre-release `HEAD` state
- **AND** untracked build debris SHALL be removed only from declared
  generator-owned paths
- **AND** rollback SHALL NOT create a `plugin/` directory
- **AND** because the clean-tree precondition held for every managed path, no
  pre-existing local edit is discarded by rollback

### Requirement: The `release` sub-command SHALL open a release PR after human confirmation

After the ROADMAP diff is confirmed, the command SHALL:
1. Stage only the release-managed paths `package.json`, `core/package.json`, `ROADMAP.md`, and the four generated host SKILLs, then create a commit on a new branch `release/vX.Y.Z` containing the version bumps, generated host SKILL output, and ROADMAP update. It SHALL NOT stage `plugin/`.
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
- **THEN** the explicit staging paths SHALL include the four generated host SKILLs
- **AND** SHALL NOT include `plugin/`
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

### Requirement: Failed staging or commit after release-branch creation SHALL restore the configured base

The live `pipeline release` path SHALL restore the configured base branch (`base_branch` from `.github/pipeline.yml`, default `main`) when `git add` or `git commit` fails after local branch `release/vX.Y.Z` exists and before a successful release commit exists on that branch. The command SHALL restore release-managed files (`package.json`, `core/package.json`, `ROADMAP.md`, and the four generated host SKILLs) to their pre-release HEAD contents in both the index and the working tree. It SHALL NOT restore or recreate `plugin/`. It SHALL NOT leave HEAD on `release/vX.Y.Z`. It SHALL NOT leave uncommitted version bumps in the index or the working tree. It SHALL delete the local `release/vX.Y.Z` branch when that branch has no unique commit, so a retry can create it again. On-disk `.agent-pipeline/frg/` files SHALL remain. A successful release commit SHALL end this restore duty; a later push failure is out of scope.

#### Scenario: git add of ignored FRG restores the base

- **WHEN** `pipeline release 1.39.5 --no-edit` has created `release/v1.39.5`
- **AND** `git add` exits non-zero because a pathspec is gitignored
- **THEN** HEAD SHALL be the configured base branch (default `main`)
- **AND** `package.json` and `core/package.json` SHALL match their pre-release versions
- **AND** HEAD SHALL NOT be `release/v1.39.5`
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` SHALL still exist if it existed before the failure
- **AND** restore SHALL NOT create a `plugin/` directory

#### Scenario: git commit failure restores the base

- **WHEN** `pipeline release 1.39.5 --no-edit` has created `release/v1.39.5`
- **AND** `git add` succeeded
- **AND** `git commit` exits non-zero
- **THEN** HEAD SHALL be the configured base branch (default `main`)
- **AND** uncommitted version bumps SHALL NOT remain in the index or the working tree
- **AND** the local `release/v1.39.5` branch SHALL NOT remain if it has no unique commit

#### Scenario: Successful commit is not rolled back by this rule

- **WHEN** `pipeline release` has created a successful release commit on `release/vX.Y.Z`
- **THEN** a later `git push` failure SHALL NOT restore the base under this requirement
- **AND** the local release commit SHALL remain for a later push retry
