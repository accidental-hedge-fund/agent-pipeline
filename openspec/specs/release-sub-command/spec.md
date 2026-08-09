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

After CI passes, the command SHALL patch `ROADMAP.md` in memory at these four sites, **after** ensuring an unshipped release-plan row exists for the resolved version (inserting a scaffolded row when missing and insert is possible):

1. **Intro paragraph** — append a new "shipped" clause for the version to the running chain sentence (e.g., `**v1.6.0 shipped YYYY-MM-DD** (tag \`v1.6.0\`) — <theme>; see Shipped.`).
2. **Release-plan table row** — update the matching unshipped `| **vX.Y.Z** |` row's status column from blank to `✅ shipped` and add a `Shipped YYYY-MM-DD` note.
3. **Shipped section** — prepend a new `**vX.Y.Z — <theme> (shipped YYYY-MM-DD, tag \`vX.Y.Z\`):**` subsection with a table of issues/PRs derived from git history since the last tag.
4. **Per-issue semver table** — stamp the `Planned ver` column for each row that matches a shipped issue number with the resolved version.

Each site's anchor is located by a pattern match (e.g., `## Shipped`, the `| **vX.Y.Z** |` row). For the release-plan row site specifically: if the unshipped row is missing, the command SHALL attempt ensure/insert first rather than aborting solely for that absence. If any **other** required anchor is not found, or if plan-row ensure cannot insert, the command SHALL abort with a non-zero exit code and an explicit error naming the missing anchor (with remediation for plan-row insert failures) rather than writing a partially-patched file.

#### Scenario: All four sites are patched atomically

- **WHEN** the scaffold succeeds
- **THEN** the ROADMAP on disk contains all four changes in a single write (no intermediate partially-patched states)

#### Scenario: Missing release-plan row is ensured before ship mutations

- **WHEN** no `| **vX.Y.Z** |` row matching the resolved version exists in ROADMAP.md
- **AND** the release-plan insert sentinel is present
- **THEN** the command SHALL insert a scaffolded unshipped plan row for that version before applying the four ship mutations
- **AND** SHALL NOT exit solely with a missing `release-plan-row` anchor error for that absence
- **AND** SHALL NOT write a partially-patched ROADMAP if a later non-plan-row anchor then fails

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

#### Scenario: PR body describes merging as the final step with the tag command as a fallback

- **WHEN** the PR body is generated for version `1.6.0`
- **THEN** it states that merging the PR is the final step that auto-tags and publishes the release
- **AND** the `git tag -a v1.6.0 -m "..." && git push origin v1.6.0` command is present but labelled as a fallback, not as a required post-merge action

#### Scenario: PR body names the RELEASE_TAG_TOKEN provisioning requirement

- **WHEN** the PR body is generated
- **THEN** the fallback note names the `RELEASE_TAG_TOKEN` repository secret and its
  provisioning (a fine-grained PAT with `contents: read` + `contents: write` on the
  repository, added as a repository Actions secret) that the auto-tag workflow requires

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

### Requirement: The `release` sub-command SHALL refuse to run when `release_model` is `continuous`

When the resolved `config.roadmap.release_model` is `'continuous'`, the `pipeline release` sub-command SHALL exit non-zero before bumping the version, regenerating the mirror, or creating any git object or GitHub resource. It SHALL print a message stating that release bundling is unavailable under the `continuous` release model and naming the `roadmap.release_model` config key.

#### Scenario: Continuous model causes immediate refusal before any mutation

- **WHEN** the user runs `pipeline release minor` and the resolved config has `roadmap.release_model === 'continuous'`
- **THEN** the command SHALL exit non-zero
- **AND** SHALL print a message naming `roadmap.release_model` and explaining that versioned release bundling is not available under the `continuous` model
- **AND** no version bump SHALL be written to any `package.json`
- **AND** no release branch, commit, or PR SHALL be created

#### Scenario: Semver model proceeds normally

- **WHEN** the user runs `pipeline release minor` and `config.roadmap.release_model` is `'semver'` or `release_model` is absent
- **THEN** the command SHALL proceed with the normal release flow without triggering the refusal gate

### Requirement: Shipped-PR discovery SHALL tolerate non-PR `(#N)` references

The `release` sub-command SHALL, when enriching a candidate PR number parsed from a
commit subject in the release range, treat a candidate that GitHub reports is **not a
pull request** as a false-positive parse (an issue reference on a non-PR commit): it
SHALL exclude that number from the shipped-PR set, SHALL emit a warning naming the
excluded number, and SHALL NOT abort the release on that basis. An excluded number SHALL
contribute no row to the scaffolded Shipped section and SHALL NOT be sent to
closing-issue resolution. This tolerance exists because a squash-merge commit and a
non-PR commit can both end in a trailing `(#N)` and cannot be told apart syntactically.

A candidate number parsed from an unambiguous `Merge pull request #N` merge-commit
subject SHALL be trusted as a pull request and SHALL NOT be excluded by this rule.

#### Scenario: A docs-style single-`(#N)` non-PR subject does not abort the release

- **WHEN** the release range contains a non-PR commit whose subject ends in a single
  issue reference (e.g. `docs: add v1.21.0 release-plan row to ROADMAP (#451)`) and
  GitHub reports that `#451` is not a pull request ("Could not resolve to a
  PullRequest")
- **THEN** the command SHALL exclude `#451` from the shipped-PR set, SHALL print a
  warning that `#451` was skipped because it is not a pull request, and SHALL continue
  the release without aborting
- **AND** the scaffolded Shipped section SHALL contain no row for `#451`
- **AND** `#451` SHALL NOT be submitted to closing-issue resolution

#### Scenario: A genuine GitHub API failure still aborts issue discovery

- **WHEN** a candidate number that *is* a pull request cannot be resolved because of a
  genuine GitHub API failure (network error, authentication failure, or rate limit)
- **THEN** the command SHALL still treat this as an issue-discovery failure and abort
  with a non-zero exit and a manual-resolution message, rather than silently producing
  an incomplete per-issue ROADMAP stamp

#### Scenario: Merge-commit PR numbers are trusted without exclusion

- **WHEN** a candidate number is parsed from a `Merge pull request #N` merge-commit
  subject
- **THEN** the command SHALL treat `#N` as a pull request and SHALL NOT apply the
  non-PR exclusion rule to it

### Requirement: Release prepare SHALL remain invocable as a shared library for programmatic callers

The release prepare implementation used by `pipeline release` SHALL remain available as a shared in-process entry point (the existing `runRelease` function or an equivalent single-sourced API) so other explicit-authority CLI surfaces can invoke the same prepare path without reimplementing version bump, mirror regeneration, CI gate, ROADMAP scaffold, or pull-request creation. Programmatic callers SHALL be able to pass dry-run and non-interactive (`noEdit`) options equivalent to the CLI flags. A live non-interactive call SHALL still stop at an open release pull request. This requirement does not add tag, publish, or merge authority to the prepare path.

#### Scenario: Programmatic dry-run prepare performs no mutations

- **WHEN** a programmatic caller invokes the shared release prepare entry with dry-run enabled
- **THEN** the prepare path SHALL NOT write release-managed files
- **AND** it SHALL NOT open a release pull request
- **AND** it SHALL NOT create or push a tag

#### Scenario: Programmatic non-interactive prepare skips the editor

- **WHEN** an explicit-authority caller invokes the shared release prepare entry with non-interactive options
- **THEN** the prepare path SHALL NOT wait on `$EDITOR`
- **AND** on success it SHALL open a release pull request for separate operator finalization

### Requirement: The release prepare path SHALL NOT gain tag, publish, or merge authority via merge-queue callers

The release prepare path SHALL remain prepare-only when invoked from merge-queue release-when-complete or any other programmatic caller. It SHALL NOT create or push git tags, publish npm packages, create GitHub Releases, or merge the release pull request. A separate direct operator action (or external supervisor under operator authority) MAY merge the prepared release pull request. Existing post-merge tag and publish workflows remain the only automated tag and publish path.

#### Scenario: Merge-queue-triggered prepare does not merge or tag

- **WHEN** release prepare is invoked because merge-queue release-when-complete passes its completeness gates
- **THEN** the prepare path SHALL stop at an open release pull request or dry-run report
- **AND** it SHALL NOT merge that pull request
- **AND** it SHALL NOT create or push a version tag as part of that invocation

#### Scenario: Programmatic prepare remains separate from finalization

- **WHEN** a programmatic caller invokes the prepare path
- **THEN** the prepare function SHALL return after it creates or reconciles the open release pull request
- **AND** a separate operator-authorized step SHALL revalidate the release head, FRG evidence, checks, and merge state before any merge

### Requirement: The `release` sub-command SHALL require a Factory Reliability Gate pass for the resolved version

The live `pipeline release` path SHALL verify, after version resolution, that a Factory Reliability
Gate (FRG) evidence artifact exists for the resolved version with `pass: true` before treating the
release as ready to open an unblocked release PR (or otherwise complete the release preparation
surface that operators use to ship). When no FRG pass artifact is found, when the artifact reports
`pass: false`, or when the artifact cannot be parsed against the expected FRG schema, the command
SHALL exit non-zero with an error that names the resolved version and how to run the FRG driver
(or points at the FRG runbook). Green `npm run ci` alone SHALL NOT satisfy this check.

The FRG check is additive to the existing `npm run ci` gate: both MUST pass. The FRG check SHALL
NOT merge any pull request and SHALL NOT create the release tag by itself.

#### Scenario: Missing FRG pass aborts release preparation

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **THEN** the command SHALL exit non-zero naming version `1.29.1` and the missing FRG
- **AND** SHALL NOT open a release pull request as a successful unblocked completion

#### Scenario: Failed FRG aborts release preparation

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: false`
- **THEN** `pipeline release` SHALL exit non-zero
- **AND** SHALL surface that the FRG failed rather than treating absence and failure identically
  only if both are distinguishable; either way the release MUST NOT proceed as ready

#### Scenario: FRG pass allows release preparation to continue past the FRG check

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: true`, a
  non-empty `run_id`, a non-empty durable `loop_run_id`, and validated fixed-pack provenance
- **AND** the existing `npm run ci` gate also succeeds (when that gate is reached in the release
  sequence)
- **THEN** the FRG check SHALL not block the release path
- **AND** the release preparation MAY proceed to subsequent steps defined by existing release
  requirements

#### Scenario: Offline or loop-less FRG claim does not unblock release

- **WHEN** an FRG artifact claims `pass: true` for the resolved version but lacks a usable
  durable `loop_run_id` or fixed-pack `pack_id`
- **THEN** `pipeline release` SHALL exit non-zero (unparsable or not release-eligible)
- **AND** SHALL NOT treat offline/fixture scoring as a substitute for a live Layer B pack run

#### Scenario: FRG check does not auto-merge or auto-tag

- **WHEN** `pipeline release` validates an FRG pass for the resolved version
- **THEN** it SHALL NOT merge the release PR as a side effect of the FRG check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because FRG passed

---

### Requirement: The release PR surface SHALL record FRG run identity for the version

The release path SHALL include or attach the FRG `run_id` and a pass summary for version `X.Y.Z`
on the release PR surface (PR body section, automated comment, or equivalent durable PR annotation)
when `pipeline release` prepares or updates that PR after a successful FRG check. Operators and
reviewers SHALL be able to locate the FRG evidence for the version from the release PR without
private out-of-band claims.

#### Scenario: Release PR references FRG run_id

- **WHEN** `pipeline release` successfully prepares a release PR for version `1.29.1` after FRG
  pass
- **THEN** the release PR body or an attached comment SHALL include the FRG `run_id` for `1.29.1`
- **AND** SHALL indicate that the FRG result was pass

#### Scenario: Missing run_id is not silently omitted after a claimed pass

- **WHEN** the FRG check would pass but the evidence artifact lacks a usable `run_id`
- **THEN** the release path SHALL fail closed rather than open a release PR without FRG identity

### Requirement: The `release` sub-command SHALL ensure an unshipped release-plan row before other ROADMAP mutations

Before applying the four ROADMAP ship mutations (intro chain, plan-row ship-mark, shipped section, per-issue stamp), the release path SHALL ensure that `ROADMAP.md` contains an unshipped release-plan table row for the resolved version. When no `| **v{version}** |` row exists for that version, the command SHALL insert a scaffolded unshipped row into the release-plan table (using the same column shape as `insertReleasePlanRow` / consumed by `patchReleasePlanRow`) **before** other ROADMAP mutations. Ensure SHALL run on the same in-memory path used by pre-validate, dry-run, and live scaffold so a missing plan row does not abort solely for absence of that row.

The ensure step SHALL NOT invent a version string: the version argument or alias resolution remains mandatory. The ensure step SHALL NOT merge, tag, or publish.

#### Scenario: Missing unshipped plan row is scaffolded then release proceeds past plan-row ensure

- **WHEN** the resolved version is `1.29.0`
- **AND** `ROADMAP.md` has no line starting with `| **v1.29.0**`
- **AND** the release-plan table insert sentinel (e.g. `| *(none)* |`) is present
- **THEN** the in-memory ROADMAP SHALL gain a new unshipped row `| **v1.29.0** | … |` before ship-mark mutations run
- **AND** the command SHALL NOT abort solely with `ROADMAP anchor not found: release-plan-row` for that absence
- **AND** subsequent ship-mark of the plan row MAY mark that scaffolded row `✅ shipped` in the same scaffold pass

#### Scenario: Ensure runs before package version writes on the live path

- **WHEN** the live release path pre-validates ROADMAP anchors before bumping `package.json` files
- **AND** the only plan-row defect is a missing unshipped row for the resolved version with a usable insert sentinel
- **THEN** ensure SHALL insert the row in memory during pre-validate
- **AND** the command SHALL NOT leave version bumps on disk solely because the plan row was initially missing

#### Scenario: Dry-run surfaces the scaffolded plan row without writing

- **WHEN** `pipeline release <version> --dry-run` runs against a ROADMAP missing the unshipped plan row for that version
- **AND** insert is possible
- **THEN** the printed ROADMAP diff SHALL include the scaffolded plan row
- **AND** no `ROADMAP.md` write SHALL occur

---

### Requirement: Scaffolded release-plan rows SHALL use documented theme and issue sources without inventing issue numbers

When the release path inserts a scaffolded release-plan row, it SHALL populate columns as follows:

- **Release:** `| **v{version}** |` (unshipped — no `✅ shipped` until the ship-mark step).
- **Bump:** derived from the resolved version (`major` / `minor` / `patch`).
- **Theme:** from `--theme` when provided; otherwise from a matching GitHub milestone title when milestone discovery is available; otherwise a documented placeholder such as `<theme>`.
- **Issues:** from milestone membership (open and closed issues for a matching milestone) and/or issue numbers already discovered from shipped PRs / `git log` on that release path. The command SHALL NOT invent issue numbers that do not appear in those sources. When no issue numbers are available yet, the Issues column MAY use a documented placeholder rather than fabricated `#N` values.
- **Why:** a short scaffold note that identifies the row as release-scaffolded (operator-editable).

#### Scenario: `--theme` overrides milestone and placeholder

- **WHEN** the operator runs release with `--theme "Factory reliability"`
- **AND** a plan row must be scaffolded for the resolved version
- **THEN** the Theme column of the scaffolded row SHALL be `Factory reliability`

#### Scenario: Milestone title used when `--theme` is absent

- **WHEN** no `--theme` flag is provided
- **AND** a GitHub milestone whose title matches the resolved version is available
- **AND** a plan row must be scaffolded
- **THEN** the Theme column SHALL use that milestone title (or a documented extraction of it)

#### Scenario: Issue column does not invent numbers

- **WHEN** a plan row must be scaffolded
- **AND** neither milestone membership nor shipped-PR / git-log discovery yields issue numbers
- **THEN** the Issues column SHALL NOT contain fabricated issue numbers
- **AND** SHALL use an empty, placeholder, or explicitly “fill manually” style value instead

---

### Requirement: The `release` sub-command SHALL never overwrite an already-shipped release-plan row

When a release-plan row for the resolved version already includes the `✅ shipped` marker, ensure and ship-mark steps SHALL leave that row’s shipped status intact. The command SHALL NOT insert a second unshipped duplicate row for the same version when a shipped row already exists.

#### Scenario: Already-shipped plan row is left unchanged by ensure

- **WHEN** `ROADMAP.md` already contains `| **v1.29.0** ✅ shipped | … |`
- **AND** no separate unshipped `| **v1.29.0** |` row exists
- **THEN** ensure SHALL NOT rewrite the shipped row to unshipped
- **AND** SHALL NOT insert a second row for `v1.29.0`

#### Scenario: Existing unshipped plan row is not duplicated

- **WHEN** `ROADMAP.md` already contains an unshipped `| **v1.29.0** |` row
- **THEN** ensure SHALL leave that row in place without inserting another row for `v1.29.0`
- **AND** ship-mark SHALL operate on the existing unshipped row as today

---

### Requirement: Impossible plan-row insert SHALL fail before version bump with doctor-grade remediation

When no unshipped plan row exists for the resolved version **and** the release path cannot safely insert one (missing release-plan table or missing insert sentinel such as `| *(none)* |`), the command SHALL exit non-zero **before** writing version bumps to `package.json` / `core/package.json`. The error message SHALL include:

1. the file path `ROADMAP.md`
2. a copy-pasteable example plan row for `v{version}` in the documented column shape
3. where to insert it (e.g. before the `| *(none)* |` sentinel, or how to restore the release-plan table)

#### Scenario: Missing insert sentinel aborts with copy-paste remediation

- **WHEN** the resolved version has no plan row
- **AND** the `| *(none)* |` (or equivalent insert) sentinel is absent so auto-insert cannot run
- **THEN** the command SHALL exit non-zero before package version writes
- **AND** the error text SHALL include a copy-pasteable `| **v{version}** | … |` row
- **AND** SHALL name `ROADMAP.md` and the expected insert location or table structure

#### Scenario: Remediation failure does not leave partial version bumps

- **WHEN** ensure fails because insert is impossible
- **THEN** `package.json` and `core/package.json` SHALL remain at their pre-release versions
- **AND** no release branch SHALL be created solely from that failure path

---

### Requirement: Release help and host SKILL SHALL document the required release-plan row shape

Release usage/help output and host SKILL documentation for `pipeline release` SHALL describe the required release-plan table row shape in a form consistent with the row produced by plan-row insert and consumed by `patchReleasePlanRow` (columns: Release, Bump, Theme, Issues, Why; Release cell `| **vX.Y.Z** |` for unshipped). The documented shape SHALL NOT contradict the shape enforced by those helpers.

#### Scenario: Help text states the unshipped plan-row shape

- **WHEN** an operator reads release help or the host SKILL release section
- **THEN** the docs SHALL show or describe the unshipped `| **vX.Y.Z** | bump | theme | issues | why |` row shape
- **AND** SHALL note that release will scaffold a missing unshipped row when the insert sentinel is present, or fail with remediation when it is not

### Requirement: The `release` sub-command SHALL fail closed on open candidate soak engine-class defects before version mutation

The live and dry-run `pipeline release` paths SHALL run the open-soak-defect preflight after version
resolution and after Factory Reliability Gate (FRG) evidence for the resolved version is available
(so soak identity can be read), and SHALL do so **before** bumping `package.json` files,
regenerating the `plugin/` mirror, running `npm run ci`, editing `ROADMAP.md`, creating a release
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
- **AND** SHALL NOT write `package.json`, `core/package.json`, or regenerate `plugin/`

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

---

### Requirement: The `release` sub-command SHALL expose an audited open-soak-defect override and record it on the PR

The release CLI SHALL accept an explicit flag that supplies a non-empty human reason to proceed
despite a non-empty open-soak-defect blocking set (exact flag spelling documented in `--help` and
consistent with release CLI conventions). When that override is used and release preparation opens
or updates the release PR, the PR body (or an attached durable PR annotation) SHALL include a
dedicated section listing the waived issue numbers and the override reason. Absence of that section
when an override was required and used SHALL be treated as a bug in the release path. Silent skip
without the flag SHALL NOT be available.

#### Scenario: Override flag with reason is required to pass a non-empty blocking set

- **WHEN** open candidate-linked engine-class defects exist
- **AND** the operator invokes `pipeline release` with the documented override flag and a non-empty
  reason
- **THEN** the open-soak-defect preflight SHALL not fail closed solely due to those defects
- **AND** release preparation MAY continue to subsequent steps

#### Scenario: Release PR body records waived issues and reason

- **WHEN** `pipeline release` successfully prepares a release PR after using the open-soak-defect
  override for issues `#712` and `#714` with reason `accepted residual; tracked offline`
- **THEN** the release PR body or durable annotation SHALL list `#712` and `#714`
- **AND** SHALL include the override reason text

#### Scenario: Override without open defects does not invent a waiver section requirement

- **WHEN** the blocking set is empty and no override flag is supplied
- **THEN** the release PR MAY omit the open-soak-defect waiver section
- **AND** preparation SHALL NOT fail for lack of that section

### Requirement: The candidate-native factory handoff SHALL use one stable prepare interface

Issue #908 SHALL add the candidate-native interface in v1.34.0 after #890 and #891. The exact non-interactive command SHALL be `pipeline factory-release prepare --request <absolute-request.json> --json`. The stable #898 wrapper SHALL invoke this command from the clean exact integrated candidate, because the currently installed engine can be one release behind the candidate that provides the command. The unchanged request SHALL be versioned, secret-free, and bound to the verified installed production pin, freshly observed base, exact integrated candidate, active release grant, and stable action identity.

The command SHALL implement an idempotent two-call protocol. The first call SHALL create or reconcile fresh unsigned FRG artifacts without an FRG credential or credential path in its environment, inherited file descriptors, candidate-action cgroup credential mount, request, or result. When those artifacts are ready, it SHALL return JSON with `status: "awaiting_frg_attestation"`, their closed identities and digests, and the stable restart checkpoint. It SHALL NOT accept or return a pass claim, open the release pull request, or receive the signing credential through this interface.

The wrapper SHALL submit those artifacts to the fixed trusted attestor defined by the Factory Reliability Gate contract. After the wrapper stores the verified production-owned attestation, it SHALL invoke the same command with the unchanged request. The second call SHALL verify the bound attestation, invoke the existing prepare-only release implementation, and return `status: "complete"` with the exact FRG run, release pull request, release head, base commit, and restart checkpoint. Repeated calls before or after attestation SHALL return the same proved state without creating a second pack, attestation, branch, or pull request.

The command SHALL grant no attestation, release-PR merge, publication, pin, install, or rollback authority. The v1.33.0 bootstrap MAY use its documented hybrid path, but no later release MAY fall back to that path.

#### Scenario: Stable wrapper calls a one-release-newer candidate

- **WHEN** the verified installed production engine is v1.33.0 and fresh `main` contains the v1.34.0 candidate implementation of #908
- **THEN** the unchanged #898 wrapper SHALL invoke `pipeline factory-release prepare --request <absolute-request.json> --json` from that exact candidate before and after trusted attestation as needed
- **AND** it SHALL NOT require a manual wrapper or config replacement

#### Scenario: First call waits for trusted attestation

- **WHEN** the unchanged request has produced complete unsigned FRG artifacts but no verified production-owned attestation exists
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"` with only the bound unsigned artifact identities, digests, and restart checkpoint
- **AND** it SHALL NOT create the release pull request

#### Scenario: Second call returns the complete release pull request

- **WHEN** the trusted attestor has stored a valid attestation for the unchanged request and exact unsigned artifacts
- **THEN** the next call SHALL prepare or reconcile one release pull request and return `status: "complete"` with its exact identity and head
- **AND** a repeat call SHALL return the same proved result without another mutation

#### Scenario: Candidate prepare does not acquire signing or finalization authority

- **WHEN** the candidate-native prepare command returns a successful JSON result
- **THEN** the factory SHALL have passed no FRG signing credential or credential path through the candidate environment, inherited file descriptors, candidate-action cgroup credential mount, request, or result
- **AND** the trusted attestor SHALL have imported or executed no candidate code
- **AND** a separate granted wrapper action SHALL still be required for merge, publication verification, pin promotion, install, or rollback

