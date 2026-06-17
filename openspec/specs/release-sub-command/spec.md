# release-sub-command Specification

## Purpose
TBD - created by archiving change release-sub-command. Update Purpose after archive.
## Requirements
### Requirement: The `release` sub-command SHALL run without an issue number

The pipeline CLI SHALL accept `release` as a positional sub-command keyword that requires no issue number and that does not advance any pipeline stage label. It SHALL be dispatched when the first positional argument is the string `release` (case-sensitive).

#### Scenario: Invoked with no issue number

- **WHEN** the user runs `pipeline release 1.6.0`
- **THEN** the command dispatches the release handler, does not read or write any pipeline stage label, and exits without touching any GitHub issue

#### Scenario: Numeric argument is rejected as ambiguous

- **WHEN** the user runs `pipeline release 42` where `42` is a digit-only string
- **THEN** the command SHALL exit non-zero with an error message explaining that a version string or alias (`major`, `minor`, `patch`) is required, and SHALL NOT treat `42` as an issue number

#### Scenario: Missing version argument exits with usage error

- **WHEN** the user runs `pipeline release` with no version argument
- **THEN** the command SHALL exit non-zero with a usage error indicating that a version or alias is required

---

### Requirement: The `release` sub-command SHALL resolve version aliases against the current package version

When the version argument is one of `major`, `minor`, or `patch`, the command SHALL read the current version from `core/package.json`, increment the appropriate segment, and use the resulting semver string for all subsequent steps.

#### Scenario: `patch` alias increments the patch segment

- **WHEN** the user runs `pipeline release patch` and `core/package.json` contains `"version": "1.5.0"`
- **THEN** the resolved version is `1.5.1`

#### Scenario: `minor` alias increments the minor segment and resets patch

- **WHEN** the user runs `pipeline release minor` and `core/package.json` contains `"version": "1.5.3"`
- **THEN** the resolved version is `1.6.0`

#### Scenario: `major` alias increments the major segment and resets minor and patch

- **WHEN** the user runs `pipeline release major` and `core/package.json` contains `"version": "1.5.0"`
- **THEN** the resolved version is `2.0.0`

#### Scenario: Explicit semver string bypasses alias expansion

- **WHEN** the user runs `pipeline release 1.6.0` with a valid `X.Y.Z` string
- **THEN** the resolved version is `1.6.0` regardless of the current package version

#### Scenario: Invalid version string is rejected before any file write

- **WHEN** the user supplies an argument that is neither a valid `X.Y.Z` semver nor one of `major`, `minor`, `patch`
- **THEN** the command SHALL exit non-zero with a clear error message and SHALL NOT write any file

---

### Requirement: The `release` sub-command SHALL bump the version in both `package.json` files

After version resolution, the command SHALL update the `version` field in both root `package.json` and `core/package.json` to the resolved version string.

#### Scenario: Both files are updated to the resolved version

- **WHEN** `pipeline release 1.6.0` runs successfully
- **THEN** `core/package.json` and root `package.json` both contain `"version": "1.6.0"` after the command writes them

#### Scenario: JSON formatting is preserved

- **WHEN** the command writes the version bump
- **THEN** the JSON indentation and structure of both files SHALL match the original (no extra whitespace changes, no key reordering beyond what `JSON.parse`/`JSON.stringify` with the original indent produces)

---

### Requirement: The `release` sub-command SHALL regenerate the `plugin/` mirror after bumping the version

After bumping both `package.json` files, the command SHALL run `node scripts/build.mjs` from the repo root. If the build script exits non-zero, the command SHALL abort with a non-zero exit code and SHALL NOT proceed to the CI gate or the ROADMAP edit.

#### Scenario: Mirror is regenerated before CI runs

- **WHEN** the version bump writes new `package.json` files
- **THEN** `node scripts/build.mjs` runs next, before `npm run ci`, ensuring the mirror is in sync when CI's `--check` runs

#### Scenario: Build failure aborts the release

- **WHEN** `node scripts/build.mjs` exits non-zero
- **THEN** the command SHALL exit non-zero, SHALL print the build output, and SHALL NOT proceed to the CI gate, ROADMAP edit, or PR creation

---

### Requirement: The `release` sub-command SHALL gate on `npm run ci` before opening a PR

After the version bump and mirror regen, the command SHALL run `npm run ci` from the repo root. If CI exits non-zero, the command SHALL abort with a non-zero exit code and SHALL NOT open a PR or create a commit.

#### Scenario: CI failure aborts before PR creation

- **WHEN** `npm run ci` exits non-zero
- **THEN** the command SHALL exit non-zero, SHALL print the CI output, and SHALL NOT write any git objects or call any GitHub API

#### Scenario: CI success proceeds to ROADMAP edit

- **WHEN** `npm run ci` exits 0
- **THEN** the command proceeds to scaffold and present the ROADMAP diff

---

### Requirement: Aborts before branch creation SHALL leave the working tree unchanged

The live release SHALL refuse to start if any release-managed path — `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, or `.claude-plugin/` — has uncommitted changes (tracked modifications or untracked files) when the command begins, failing fast with a non-zero exit before bumping the version, regenerating the mirror, or writing any file. This clean-tree precondition makes the rollback provably lossless.

Untracked-file detection SHALL be forced independent of the user's git configuration (i.e. it SHALL NOT rely on `status.showUntrackedFiles`), because the mirror regen step removes and rebuilds `plugin/` wholesale and would otherwise destroy an untracked file the guard failed to report. Ignored files under the regenerated mirror directories (`plugin/`, `.claude-plugin/`) are explicitly excluded from the lossless guarantee: those directories are generated build output that the mirror regen rewrites wholesale, so git-ignored content there is disposable by repo convention.

Any abort after the version bump and mirror regen but before the release branch is created — mirror-regen failure, CI failure, issue-discovery failure, or an editor abort — SHALL restore `package.json`, `core/package.json`, `ROADMAP.md`, and the regenerated `plugin/` mirror to their pre-release (HEAD) state and remove any untracked mirror debris generated during the run, so a retry reads the original `previousVersion` and is not poisoned by stranded version/mirror changes. Because the precondition guaranteed these paths matched HEAD at the start, the rollback restores exactly the pre-release working tree and never discards a maintainer's pre-existing edits.

#### Scenario: A dirty release-managed path fails fast before any mutation

- **WHEN** any of `package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, or `.claude-plugin/` has uncommitted changes at the start of a live release
- **THEN** the command SHALL exit non-zero naming the dirty paths and SHALL NOT bump the version, regenerate the mirror, or write any file
- **AND** because nothing was mutated, no rollback is performed (there is nothing to restore and nothing to discard)

#### Scenario: Untracked-file detection does not depend on user git config

- **WHEN** the clean-tree precondition checks the release-managed paths
- **THEN** it SHALL force untracked-file reporting (e.g. `git status --porcelain --untracked-files=all`) so an untracked file under `plugin/` is detected even when the maintainer has `status.showUntrackedFiles=no` configured

#### Scenario: post-bump abort rolls back the bumped files

- **WHEN** the command bumps the version, regenerates the mirror, then aborts (CI fails, issue discovery fails, or the editor aborts) before creating the release branch
- **THEN** `package.json` and `core/package.json` SHALL be restored to their pre-bump contents from HEAD
- **AND** the `plugin/` mirror SHALL be restored to its pre-release state and any untracked build debris removed
- **AND** `ROADMAP.md` SHALL NOT be left in a stamped or partially-patched state
- **AND** because the clean-tree precondition held at the start, no pre-existing local edit in any release-managed path is discarded by the rollback

---

### Requirement: The `release` sub-command SHALL scaffold `ROADMAP.md` at four locations

After CI passes, the command SHALL patch `ROADMAP.md` in memory at these four sites:

1. **Intro paragraph** — append a new "shipped" clause for the version to the running chain sentence (e.g., `**v1.6.0 shipped YYYY-MM-DD** (tag \`v1.6.0\`) — <theme>; see Shipped.`).
2. **Release-plan table row** — update the matching `| **vX.Y.Z** |` row's status column from blank to `✅ shipped` and add a `Shipped YYYY-MM-DD` note.
3. **Shipped section** — prepend a new `**vX.Y.Z — <theme> (shipped YYYY-MM-DD, tag \`vX.Y.Z\`):**` subsection with a table of issues/PRs derived from git history since the last tag.
4. **Per-issue semver table** — stamp the `Planned ver` column for each row that matches a shipped issue number with the resolved version.

Each site's anchor is located by a pattern match (e.g., `## Shipped`, the `| **vX.Y.Z** |` row). If any anchor is not found, the command SHALL abort with a non-zero exit code and an explicit error naming the missing anchor rather than writing a partially-patched file.

#### Scenario: All four sites are patched atomically

- **WHEN** the scaffold succeeds
- **THEN** the ROADMAP on disk contains all four changes in a single write (no intermediate partially-patched states)

#### Scenario: Missing release-plan row aborts

- **WHEN** no `| **vX.Y.Z** |` row matching the resolved version exists in ROADMAP.md
- **THEN** the command SHALL exit non-zero naming the missing anchor and SHALL NOT write any file

#### Scenario: Shipped PRs that resolve no stampable rows abort

- **WHEN** shipped PRs exist and per-issue rows are planned for the resolved version, but none of those rows can be stamped because the shipped PRs resolve no matching closing issue numbers (e.g. empty `closingIssuesReferences`)
- **THEN** the command SHALL abort with a non-zero exit code and a manual-resolution message rather than writing an unstamped, inconsistent release ROADMAP
- **AND** when no per-issue rows are planned for the resolved version, the command SHALL NOT abort on this basis

#### Scenario: Scaffolded PR/issue rows are derived from `git log` since the last tag

- **WHEN** the command determines what shipped
- **THEN** it SHALL run `git log <last-release-tag>..HEAD` and extract PR numbers from merge-commit messages (standard GitHub `Merge pull request #N` pattern) and from squash-merge commit messages (parenthetical `(#N)` pattern), then scaffold one table row per PR in the Shipped subsection

#### Scenario: No merged PRs detected

- **WHEN** `git log` since the last tag yields no recognizable PR references
- **THEN** the scaffolded Shipped subsection SHALL contain a placeholder row `| (no merged PRs detected — fill manually) |` and the command SHALL print a warning

---

### Requirement: The `release` sub-command SHALL present the ROADMAP diff for human confirmation before opening a PR

After scaffolding ROADMAP.md, the command SHALL open the file in `$EDITOR` for the maintainer to review and finalize the scaffolded prose. The PR SHALL NOT be opened until the editor exits.

Under `--no-edit`, the editor is skipped and the scaffolded diff is committed as-is.

If `$EDITOR` is not set and `--no-edit` is not passed, the command SHALL warn and proceed as if `--no-edit` were passed.

#### Scenario: Editor launched for human confirmation

- **WHEN** `pipeline release 1.6.0` is run without `--no-edit` or `--dry-run` and `$EDITOR` is set
- **THEN** the command SHALL open `ROADMAP.md` in `$EDITOR` and block until the editor process exits before continuing to PR creation

#### Scenario: `--no-edit` skips the editor

- **WHEN** `pipeline release 1.6.0 --no-edit` is run
- **THEN** the command SHALL NOT launch any editor and SHALL proceed directly from the scaffold write to PR creation

---

### Requirement: The `release` sub-command SHALL open a release PR after human confirmation

After the ROADMAP diff is confirmed, the command SHALL:
1. Create a commit on a new branch `release/vX.Y.Z` containing the version bumps, mirror regen output, and ROADMAP update.
2. Open a PR via `gh pr create` with title `release: X.Y.Z — <theme>` and a body listing the included issues/PRs.
3. Print the PR URL on success.

The PR body SHALL include at minimum: the resolved version, the list of issues/PRs merged since the last release tag (with numbers and titles), and the instruction that merging the PR then pushing the `vX.Y.Z` tag triggers the automated GitHub Release.

#### Scenario: PR is opened with the correct title

- **WHEN** the release command completes successfully with version `1.6.0`
- **THEN** `gh pr view` for the created PR shows a title matching `release: 1.6.0 — <theme>`

#### Scenario: PR body lists issues/PRs since the last tag

- **WHEN** the PR is opened
- **THEN** the PR body contains a section listing each PR number and title included in the release

#### Scenario: PR URL is printed to stdout

- **WHEN** the PR is created successfully
- **THEN** the command prints the PR URL to stdout before exiting 0

---

### Requirement: The `release` sub-command SHALL support `--dry-run`

Under `--dry-run`, the command SHALL resolve the version, compute the version-bump diff, compute the ROADMAP scaffold diff, and compose the PR body — then print all three to stdout and exit 0 without writing any file, creating any commit, or calling any GitHub API.

#### Scenario: `--dry-run` prints without writing

- **WHEN** `pipeline release 1.6.0 --dry-run` is run
- **THEN** the resolved version, the file diffs, and the PR body are printed to stdout
- **AND** no file on disk is modified
- **AND** no git commit is created
- **AND** no GitHub API is called

#### Scenario: `--dry-run` still validates the version argument

- **WHEN** `pipeline release foo --dry-run` is run
- **THEN** the command SHALL exit non-zero with a version-validation error, same as without `--dry-run`

---

### Requirement: The `release` sub-command SHALL NOT merge, tag, or publish

The release sub-command SHALL stop at the open PR. It SHALL NOT:
- Merge the PR.
- Push a `vX.Y.Z` tag.
- Create or publish a GitHub Release.

These actions are the maintainer's and the post-merge `release.yml` workflow's domain, respectively.

#### Scenario: Command exits after PR creation without merging

- **WHEN** `pipeline release 1.6.0` completes successfully
- **THEN** the PR exists in open/draft state
- **AND** no merge, tag, or release object has been created

