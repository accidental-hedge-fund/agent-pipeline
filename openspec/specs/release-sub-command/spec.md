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

After CI passes, the command SHALL **attempt** to patch `ROADMAP.md` in memory at documentation sites that still exist in the file, for human-readable derived docs only. ROADMAP is **not** the release-plan authority; planned membership comes from the GitHub milestone (see milestone plan-membership requirement).

When the relevant anchors are present, the command MAY:

1. **Intro paragraph** — append a new "shipped" clause for the version when that site is still maintained.
2. **Release-plan table row** — ensure/update a matching `| **vX.Y.Z** |` row's status toward shipped documentation when the table exists (inserting a scaffolded row when missing and insert is possible remains allowed as best-effort docs hygiene).
3. **Shipped section** — when a shipped-section structure is present and still maintained by the release path, update it from git history since the last tag; when the project uses `CHANGELOG.md` as the primary history surface, the release path SHALL NOT reintroduce unbounded Shipped prose solely to satisfy a missing anchor.
4. **Per-issue semver table** — best-effort stamp of `Planned ver` / shipped markers for issue numbers that appear in the **milestone plan set and/or shipped closing-issue set** when the table exists.

If a documentation anchor is missing, the command SHALL skip that site with a warning rather than aborting the release solely for that absence. The command SHALL NOT require ROADMAP plan rows to match shipped PRs as a condition of success.

#### Scenario: All four sites are patched atomically

- **WHEN** the scaffold succeeds and all four documentation site anchors are present
- **THEN** the ROADMAP on disk contains all four documentation changes in a single write (no intermediate partially-patched states)
- **AND** when one or more plan-related anchors are missing, the command SHALL skip those sites without writing a partially-patched ROADMAP that claims success for missing sites

#### Scenario: Missing release-plan row is ensured before ship mutations

- **WHEN** no `| **vX.Y.Z** |` row matching the resolved version exists in ROADMAP.md
- **AND** the release-plan insert sentinel is present
- **THEN** the command MAY insert a scaffolded unshipped plan row for that version before other optional ROADMAP documentation mutations
- **AND** SHALL NOT exit solely with a missing `release-plan-row` anchor error for that absence when milestone plan resolution succeeded
- **AND** SHALL NOT write a partially-patched ROADMAP if a later non-plan-row documentation site fails mid-write

#### Scenario: Shipped PRs that resolve no stampable rows abort

- **WHEN** shipped PRs exist and per-issue ROADMAP rows are planned for the resolved version, but none of those ROADMAP rows can be stamped because the shipped PRs resolve no matching closing issue numbers against those rows
- **THEN** the command SHALL NOT abort solely for that ROADMAP stamp mismatch when planned membership was resolved from the matching GitHub milestone
- **AND** the command MAY warn that ROADMAP per-issue documentation stamps were incomplete
- **AND** when no matching milestone exists, the live missing-milestone refusal applies instead of this ROADMAP stamp gate

#### Scenario: Scaffolded PR/issue rows are derived from `git log` since the last tag

- **WHEN** the command determines what shipped for PR body and optional ROADMAP docs
- **THEN** it SHALL run `git log <last-release-tag>..HEAD` and extract PR numbers from merge-commit messages (standard GitHub `Merge pull request #N` pattern) and from squash-merge commit messages (parenthetical `(#N)` pattern), then MAY scaffold one documentation table row per PR when a shipped-section structure is still maintained

#### Scenario: No merged PRs detected

- **WHEN** `git log` since the last tag yields no recognizable PR references
- **THEN** any scaffolded Shipped documentation subsection SHALL contain a placeholder row `| (no merged PRs detected — fill manually) |` or equivalent clear empty representation and the command SHALL print a warning
- **AND** the command SHALL NOT abort solely for an empty shipped set when other gates pass

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

Under `--dry-run`, the command SHALL resolve the version, compute the version-bump diff, compute any optional ROADMAP documentation scaffold diff when anchors allow, compose the PR body preview, and report milestone presence/open-issue status for the resolved version (read-only GitHub lookup permitted) — then print those artifacts to stdout and exit 0 without writing any file, creating any commit, or calling any **mutating** GitHub API. Dry-run SHALL NOT open a pull request.

#### Scenario: `--dry-run` prints without writing

- **WHEN** `pipeline release 1.6.0 --dry-run` is run
- **THEN** the resolved version, the file diffs (when applicable), the PR body preview, and the milestone status summary are printed to stdout
- **AND** no file on disk is modified
- **AND** no git commit is created
- **AND** no pull request is opened
- **AND** no mutating GitHub API is called

#### Scenario: `--dry-run` still validates the version argument

- **WHEN** `pipeline release foo --dry-run` is run
- **THEN** the command SHALL exit non-zero with a version-validation error, same as without `--dry-run`

#### Scenario: `--dry-run` may read milestone metadata

- **WHEN** `pipeline release 1.6.0 --dry-run` runs with network available
- **THEN** the command MAY perform a read-only milestone lookup for version `1.6.0`
- **AND** SHALL still perform no file writes and no PR creation

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

### Requirement: Release prepare JSON SHALL return typed candidate identity

The release prepare machine interface SHALL return one typed result from
`pipeline release <version> --no-edit --json` and the shared programmatic
prepare entry containing at least
`schema_version`, `kind: "release_prepare"`, the resolved `version`, release
pull-request number `pr`, target `base`, and exact release pull-request
`head_oid`. Machine consumers SHALL use this result instead of parsing prose,
the PR title, or a repository-wide PR search.

#### Scenario: Prepare returns one bound release result

- **WHEN** non-interactive release prepare creates or reconciles a release PR
  with `--json`
- **THEN** stdout SHALL parse as exactly one unfenced JSON object
- **AND** the object SHALL bind the resolved version, PR, base, and exact head

#### Scenario: Finalization revalidates prepare identity

- **WHEN** a coordinator finalizes a release from a prepare result
- **THEN** it SHALL supply that typed identity to the existing release-finish
  implementation and re-observe the PR before merge
- **AND** a version, base, or head mismatch SHALL fail closed before merge

#### Scenario: Prose is not a machine interface

- **WHEN** release prepare logs human-readable progress or changes its prose
- **THEN** machine consumers SHALL continue to use the typed result
- **AND** they SHALL NOT discover the release PR by regular expression or title
  search

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

The command SHALL skip that FRG check when the shared skip resolution is active: explicit CLI
`--skip-frg`, or else `.github/pipeline.yml` `skip_frg: true` when the flag is absent. Unset or
`skip_frg: false` SHALL leave the FRG check required. When only the yml key causes the skip, the
skip log SHALL name config. Config SHALL NOT force the FRG check on if the operator passed
`--skip-frg`.

#### Scenario: Missing FRG pass aborts release preparation

- **WHEN** the user runs `pipeline release 1.29.1` (or an alias that resolves to `1.29.1`)
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
- **THEN** the command SHALL exit non-zero naming version `1.29.1` and the missing FRG
- **AND** SHALL NOT open a release pull request as a successful unblocked completion

#### Scenario: Failed FRG aborts release preparation

- **WHEN** an FRG evidence artifact for the resolved version exists with `pass: false`
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
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
- **AND** `--skip-frg` is absent and `skip_frg` is unset or false
- **THEN** `pipeline release` SHALL exit non-zero (unparsable or not release-eligible)
- **AND** SHALL NOT treat offline/fixture scoring as a substitute for a live Layer B pack run

#### Scenario: FRG check does not auto-merge or auto-tag

- **WHEN** `pipeline release` validates an FRG pass for the resolved version
- **THEN** it SHALL NOT merge the release PR as a side effect of the FRG check
- **AND** SHALL NOT create the `vX.Y.Z` tag solely because FRG passed

#### Scenario: Config skip_frg true skips the FRG check without the flag

- **WHEN** `.github/pipeline.yml` sets `skip_frg: true`
- **AND** the user runs `pipeline release 1.29.1` without `--skip-frg`
- **AND** no FRG evidence artifact with `version: 1.29.1` and `pass: true` is available
- **THEN** the command SHALL skip the FRG check
- **AND** the skip log SHALL name config as the source

#### Scenario: CLI --skip-frg still skips when skip_frg is unset or false

- **WHEN** `.github/pipeline.yml` omits `skip_frg` or sets `skip_frg: false`
- **AND** the user runs `pipeline release 1.29.1` with `--skip-frg`
- **THEN** the command SHALL skip the FRG check

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

When the release path inserts or updates a **documentation** release-plan row in ROADMAP (best-effort), it SHALL populate columns as follows:

- **Release:** `| **v{version}** |` (unshipped until ship-mark when that step runs).
- **Bump:** derived from the resolved version (`major` / `minor` / `patch`).
- **Theme:** from `--theme` when provided; otherwise from the matching GitHub milestone title when available; otherwise a documented placeholder such as `<theme>`. ROADMAP is not an input authority for theme.
- **Issues:** from **milestone membership** (primary) and/or issue numbers discovered from shipped PRs / `git log`. The command SHALL NOT invent issue numbers that do not appear in those sources. When no issue numbers are available yet, the Issues column MAY use a documented placeholder rather than fabricated `#N` values.
- **Why:** a short scaffold note that identifies the row as release-scaffolded (operator-editable).

#### Scenario: `--theme` overrides milestone and placeholder

- **WHEN** the operator runs release with `--theme "Factory reliability"`
- **AND** a plan row is written for documentation
- **THEN** the Theme column of that row SHALL be `Factory reliability`

#### Scenario: Milestone title used when `--theme` is absent

- **WHEN** no `--theme` flag is provided
- **AND** a GitHub milestone whose title matches the resolved version is available
- **AND** a plan row is written for documentation
- **THEN** the Theme column SHALL use that milestone title (or a documented extraction of it)

#### Scenario: Issue column does not invent numbers

- **WHEN** a plan row is written for documentation
- **AND** neither milestone membership nor shipped-PR / git-log discovery yields issue numbers
- **THEN** the Issues column SHALL NOT contain fabricated issue numbers
- **AND** SHALL use an empty, placeholder, or explicitly "fill manually" style value instead

#### Scenario: Issues column prefers milestone membership

- **WHEN** milestone membership is `[#910, #978]` and ROADMAP previously listed `[#901, #765]`
- **AND** a documentation plan row is written
- **THEN** the Issues column SHALL reflect the milestone membership (or a documented merge with shipped discovery), not the stale ROADMAP list as authority

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

### Requirement: Ship coordination SHALL reuse the normal release prepare interface

The ship coordinator and the durable factory-release prepare path SHALL invoke the same shared release prepare entry used by `pipeline release` when opening or reconciling the release pull request. They SHALL NOT implement an alternate release builder, wrapper-local PR discovery protocol, or second release state machine that diverges from prepare-only release semantics. The durable command `pipeline factory-release prepare` MAY orchestrate FRG generation and the attestation checkpoint before it calls that shared entry. After all existing FRG and release gates pass, ship SHALL store the typed prepare result and pass that identity into release finalization.

#### Scenario: Ship prepare uses the shared implementation

- **WHEN** an authorized ship reaches release preparation for a version that has release-eligible FRG evidence
- **THEN** it SHALL call the shared `runRelease` implementation or its stable equivalent (directly or via `factory-release prepare` after attestation)
- **AND** the returned typed version, PR, base, and head SHALL become the finalization identity

#### Scenario: Factory-release is not a second release builder

- **WHEN** `pipeline factory-release prepare` opens or reconciles a release pull request
- **THEN** it SHALL do so only by invoking the shared `runRelease` prepare path
- **AND** it SHALL NOT merge, tag, publish, promote, or install as a side effect

#### Scenario: Ship prepare grants no finalization authority by itself

- **WHEN** release prepare returns its typed identity
- **THEN** it SHALL NOT merge, tag, publish, promote, or install as a side effect
- **AND** the ship coordinator SHALL revalidate its authorization and observed release identity before each later mutation

### Requirement: The candidate-native factory handoff SHALL use one stable prepare interface

The engine SHALL expose the exact non-interactive command `pipeline factory-release prepare --request <absolute-request.json> --json` for durable FRG generation and prepare-only release handoff on every release after v1.33.0. Ship-end composers (Tugboat, the installed `pipeline-ship-playbook` launcher, and in-engine `pipeline ship`) SHALL invoke this command, `pipeline release`, and `release finish` from the clean exact integrated candidate when the installed production engine is one release behind the candidate that provides the command. In-engine `pipeline ship` SHALL also run `ensureAnnotatedReleaseTag` from that candidate. Tugboat SHALL NOT invoke `git tag` or `gh release create`. They SHALL NOT invoke those verbs from the previous production-pin CLI in that case. The request SHALL be versioned, secret-free, and bound to the verified installed production pin (when present), freshly observed base, exact integrated candidate, target release version, and stable action identity when supplied. The request SHALL NOT carry FRG credentials, executable paths, module names, network targets, or caller-authored pass claims.

The command SHALL implement an idempotent multi-tick protocol. A call for a post-1.33 request with no request-bound pack loop, or with a bound loop that is not terminal, SHALL start or resume that bound candidate pack loop, persist `loop_run_id` and the matching request binding before spawn, and return JSON with `status: "in_progress"`, the bound `loop_run_id`, and a stable restart checkpoint. A failed detached spawn SHALL fail that tick and SHALL leave the request bound to the same `loop_run_id` so a later invoke can resume it. That call SHALL NOT invent `pass: true`, SHALL NOT return `status: "complete"`, and SHALL NOT open the release pull request. A repeat call with the **unchanged** request SHALL resume the same `loop_run_id` and SHALL NOT start a second unbound pack.

When the bound pack loop is terminal, the command SHALL score it with `pipeline factory-gate --for <target-version> --from-run <loop_run_id>` (or the in-process equivalent) and SHALL NOT pass `--observations`. Complete unsigned FRG artifacts SHALL exist when scoreboard and composition meet release-eligibility except HMAC is absent, even if `.agent-pipeline/frg/<X.Y.Z>/latest.json` records `pass: false` solely because HMAC was omitted. Only after that score produces complete unsigned FRG artifacts, and no verified production-owned attestation exists, SHALL the command return JSON with `status: "awaiting_frg_attestation"`, closed unsigned artifact identities and digests, and a stable restart checkpoint. It SHALL NOT open the release pull request on that call. It SHALL NOT return `status: "failed"` or `defect_class: "frg_not_eligible"` when HMAC is the only missing piece. A re-observe of a prior omitted-HMAC `failed` checkpoint for the same unchanged request SHALL return `awaiting_frg_attestation` when the pack is still structurally eligible.

After the wrapper stores a verified production-owned attestation for those exact artifacts, a later call with the **unchanged** request SHALL verify the bound attestation, invoke the existing prepare-only release implementation, and return `status: "complete"` with the exact FRG run identity, release pull request, release head, base commit, and restart checkpoint. Repeated calls at any proved checkpoint SHALL return the same proved state without creating a second pack, loop, attestation, branch, or pull request.

The command SHALL grant no attestation signing, release-PR merge, publication, pin, install, rollback, or Tugboat `--skip-frg` authority. The v1.33.0 hybrid path SHALL NOT be used as a fallback when this command is missing or fails for a later release.

#### Scenario: First call waits for trusted attestation

- **WHEN** the unchanged request has produced complete unsigned FRG artifacts but no verified production-owned attestation exists
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"` with only the bound unsigned artifact identities, digests, and restart checkpoint
- **AND** it SHALL NOT create the release pull request

#### Scenario: Omitted HMAC is not frg_not_eligible

- **WHEN** the bound pack loop is terminal
- **AND** scoreboard and composition meet release-eligibility except HMAC is absent
- **AND** `.agent-pipeline/frg/<X.Y.Z>/latest.json` records `pass: false` because HMAC was omitted
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"`
- **AND** it SHALL NOT return `status: "failed"`
- **AND** it SHALL NOT return `defect_class: "frg_not_eligible"`
- **AND** it SHALL NOT invent `pass: true`

#### Scenario: Stale omitted-HMAC failed checkpoint is re-observed as awaiting

- **WHEN** a prior tick persisted `status: "failed"` and `defect_class: "frg_not_eligible"` because HMAC was omitted
- **AND** a later call uses the unchanged request
- **AND** the bound pack is still structurally eligible
- **THEN** the command SHALL return `status: "awaiting_frg_attestation"`
- **AND** it SHALL NOT replay that failed checkpoint as terminal pack-fail

#### Scenario: Second call returns the complete release pull request

- **WHEN** the trusted attestor has stored a valid attestation for the unchanged request and exact unsigned artifacts
- **THEN** the next call SHALL prepare or reconcile one release pull request via shared `runRelease` and return `status: "complete"` with its exact identity and head
- **AND** a repeat call SHALL return the same proved result without another pack, branch, or pull request mutation

#### Scenario: Candidate prepare does not acquire signing or finalization authority

- **WHEN** the candidate-native prepare command returns a successful JSON result
- **THEN** the factory SHALL have passed no FRG signing credential or credential path through the candidate environment, inherited file descriptors, request, or result
- **AND** a separate granted or operator action SHALL still be required for merge, publication verification, pin promotion, install, or rollback

#### Scenario: Crash mid-protocol re-observes before mutate

- **WHEN** the process stops after pack creation, after binding persist, after loop dispatch, after attestation storage, or after release PR creation but before checkpoint advancement
- **THEN** a restart with the same request SHALL re-observe pack, loop, run, attestation, branch, PR, and head state
- **AND** it SHALL continue from the proved checkpoint without creating a duplicate pack, loop, branch, or release PR

#### Scenario: Missing or failed FRG blocks complete status

- **WHEN** required FRG evidence is missing, stale, failed, mismatched, skipped, or waived without policy support
- **THEN** the command SHALL NOT return `status: "complete"`
- **AND** it SHALL exit non-zero or return a failure status that names the version and defect class

#### Scenario: Structural ineligibility still fails

- **WHEN** the bound pack loop is terminal
- **AND** composition is missing or a required scenario fails
- **THEN** the command SHALL NOT return `status: "awaiting_frg_attestation"`
- **AND** it SHALL return a failure status that names `frg_not_eligible` or the structural defect

#### Scenario: First call with no bound loop returns in-progress

- **WHEN** a post-1.33 prepare request has no request-bound pack loop
- **THEN** the command SHALL start a bound candidate pack loop and return `status: "in_progress"` with that `loop_run_id` and a restart checkpoint
- **AND** it SHALL NOT return `status: "complete"` or invent `pass: true`
- **AND** it SHALL NOT treat the missing pre-bound loop as `missing_generator`

#### Scenario: Re-invoke resumes the same loop_run_id

- **WHEN** a later call uses the unchanged request
- **AND** the pack instance already records bound `loop_run_id` `L`
- **THEN** the command SHALL resume `L` and return the same proved in-progress, awaiting, complete, or failed state
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Ship-end composers invoke prepare from the candidate when the pin is behind

- **WHEN** the installed production engine is version `1.39.4`
- **AND** the exact integrated candidate SHA provides `factory-release prepare` and `release` at `1.39.5`
- **THEN** Tugboat, the installed playbook copy, and in-engine `pipeline ship` SHALL invoke those commands from that candidate
- **AND** they SHALL NOT invoke them from the `1.39.4` production-pin CLI

### Requirement: Release prepare SHALL NOT be the sole writer of the shipped tag CHANGELOG entry

The prepare path (`pipeline release <version>`) SHALL continue to stop at an open release PR without merging, tagging, or publishing. Prepare MAY regenerate the `plugin/` mirror and other non-tag artifacts as today, but it SHALL NOT be relied on as the only mechanism that writes the generator-owned `CHANGELOG.md` section for the version being released. The shipped `## [X.Y.Z]` (or equivalent generator) entry for that version is the obligation of the post-tag docs-refresh path defined with auto-tag / release completion (see `generated-changelog` and `release-auto-tag-on-merge`), because the annotated tag that is the CHANGELOG source of truth does not exist until after the release merge.

#### Scenario: Prepare success without claiming post-tag CHANGELOG freshness

- **WHEN** `pipeline release 1.34.0` completes successfully and opens a release PR
- **THEN** the command SHALL still not merge, tag, or publish
- **AND** operators and automation SHALL treat tag-derived `CHANGELOG.md` freshness for `1.34.0` as incomplete until the post-tag docs-refresh path has run after `v1.34.0` exists

#### Scenario: Prepare does not gain tag authority to force CHANGELOG

- **WHEN** release prepare runs for version `X.Y.Z`
- **THEN** it SHALL NOT push annotated tag `vX.Y.Z` solely to regenerate CHANGELOG
- **AND** it SHALL NOT publish a GitHub Release

---

### Requirement: Release finish MAY heal docs after tag observation without owning tag creation

The operator-authorized `pipeline release finish <pr>` command SHALL continue to merge the release PR without itself creating tags or GitHub Releases. After a successful merge, finish SHALL return `mergeCommitOid` in JSON so a ship-end composer can invoke `pipeline release ensure-tag`. Finish MAY observe that annotated tag `vX.Y.Z` exists and invoke the same post-tag docs-refresh helper used by the auto-tag path when the local environment can write the default branch. When the auto-tag path has already committed an identical generator tree, finish's refresh SHALL be an idempotent no-op (no empty commit). Finish SHALL NOT delete tags, SHALL NOT publish releases, and SHALL NOT treat docs heal failure as a reason to unmerge the PR.

When `.agent-pipeline/frg/` is gitignored, ship-end tag creation SHALL be `pipeline release ensure-tag` (or in-process `ensureAnnotatedReleaseTag`) from on-disk HMAC `latest.json`, not auto-tag-release reading the merged tree. Finish SHALL NOT become that tag owner.

#### Scenario: Finish remains merge-authorized and tag-free

- **WHEN** `pipeline release finish <pr>` merges a valid release PR
- **THEN** the command SHALL NOT create or push the version tag
- **AND** tag creation SHALL be `pipeline release ensure-tag` on the ship-end composer, not finish itself

#### Scenario: Finish JSON includes mergeCommitOid

- **WHEN** `pipeline release finish <pr> --json` merges a valid release PR
- **AND** GitHub reports a merge commit OID
- **THEN** the JSON result SHALL include that OID as `mergeCommitOid`

#### Scenario: Optional post-tag heal is idempotent

- **WHEN** finish observes tag `vX.Y.Z` after merge
- **AND** it invokes post-tag docs refresh
- **AND** committed generator-owned docs already match a fresh generation from current tags
- **THEN** finish SHALL succeed without creating an empty commit

### Requirement: Release plan membership SHALL come from the matching GitHub milestone

For a resolved SemVer version `X.Y.Z`, `pipeline release` (and its shared prepare entry) SHALL treat the matching GitHub milestone as the sole authority for **planned** issue membership for that release. Planned issue numbers SHALL be the non-PR issues assigned to that milestone (open and closed). The command SHALL NOT use `ROADMAP.md` release-plan table rows or per-issue `→ Release` plan cells as the authority for which issues were planned for the version.

Milestone match rules SHALL remain version-aware (title contains `vX.Y.Z` or a bare `X.Y.Z` token bounded so it does not match a different patch/minor). The command SHALL NOT invent issue numbers that do not appear on the milestone or in shipped-PR discovery sources.

#### Scenario: Planned issues loaded from milestone membership

- **WHEN** a GitHub milestone matching version `1.35.0` exists and its non-PR issues are `#910`, `#978`, `#980`, and `#983`
- **AND** `ROADMAP.md` lists different planned issues for `v1.35.0` (for example `#901` and `#765`)
- **THEN** the release prepare path SHALL use `[#910, #978, #980, #983]` as the planned issue set
- **AND** SHALL NOT treat the ROADMAP list as plan authority

#### Scenario: Milestone issues do not invent numbers

- **WHEN** milestone membership and shipped-PR discovery yield no issue numbers
- **THEN** the prepare path SHALL NOT fabricate `#N` values for planned membership

---

### Requirement: Live release prepare SHALL fail closed when no matching milestone exists

When `pipeline release` runs a **live** prepare (not dry-run) under the SemVer release path and no GitHub milestone matching the resolved version exists, the command SHALL exit non-zero **before** opening a release pull request, with an error that names the resolved version and remediation (create the milestone and/or run `pipeline roadmap --apply`). It SHALL NOT treat a missing milestone as an empty silent plan.

#### Scenario: Missing milestone aborts live prepare

- **WHEN** the operator runs a live `pipeline release 1.36.0` (or an alias resolving to `1.36.0`)
- **AND** no matching GitHub milestone exists for `1.36.0`
- **THEN** the command SHALL exit non-zero naming version `1.36.0` and the missing milestone
- **AND** SHALL NOT open a release pull request as a successful completion

#### Scenario: Present milestone allows plan resolution to continue

- **WHEN** a matching milestone exists for the resolved version
- **THEN** plan membership resolution SHALL succeed from that milestone
- **AND** the missing-milestone refusal SHALL NOT apply

---

### Requirement: Live release prepare SHALL fail closed when multiple milestones match the version

When `pipeline release` runs a **live** prepare (not dry-run) under the SemVer release path and **more than one** GitHub milestone matches the resolved version by the version-aware title rules, the command SHALL exit non-zero **before** opening a release pull request. The error SHALL name the resolved version and identify the matching milestones (numbers and/or titles) with remediation to keep exactly one canonical match (rename or close extras). The command SHALL NOT silently select the first REST-list entry, and SHALL NOT invent plan membership from an arbitrary match.

GitHub permits duplicate milestone titles; list ordering is not a release-plan disambiguation contract.

#### Scenario: Duplicate matching milestones abort live prepare

- **WHEN** the operator runs a live `pipeline release 1.36.0`
- **AND** two or more GitHub milestones match version `1.36.0` (for example an accidental old `v1.36.0` and an intended one with different issue membership)
- **THEN** the command SHALL exit non-zero naming version `1.36.0` and the ambiguity
- **AND** SHALL NOT open a release pull request as a successful completion
- **AND** SHALL NOT treat either matching milestone as the sole plan authority without operator disambiguation

#### Scenario: Exactly one matching milestone is required for plan resolution

- **WHEN** exactly one GitHub milestone matches the resolved version
- **THEN** plan membership resolution SHALL use that milestone
- **AND** the ambiguous-milestone refusal SHALL NOT apply

---

### Requirement: Stale or missing ROADMAP plan anchors SHALL NOT block a milestone-backed release

When planned membership has been resolved from a matching GitHub milestone (or live prepare has already failed closed for a missing milestone), the release path SHALL NOT abort solely because:

- `ROADMAP.md` is missing a `release-plan-row` for the version,
- the `release-plan-none-row` insert sentinel is absent,
- a `shipped-section` anchor is absent, or
- ROADMAP per-issue rows are planned for the version but none are stampable from shipped closing-issue numbers (including the historical failure text of the form "found N shipped PR(s) and M ROADMAP row(s) planned … but none could be stamped").

Optional ROADMAP documentation mutations (for example compact plan-row ship-mark or per-issue stamps) SHALL be best-effort: applied when the needed anchors exist; skipped with an explicit warning when they do not. Success of release prepare SHALL not require those mutations.

#### Scenario: v1.35.0-class ROADMAP stamp mismatch does not abort

- **WHEN** shipped PRs resolve closing issues that match the milestone membership for the version
- **AND** `ROADMAP.md` still has per-issue rows planned for that version that do not match those shipped issues (stampable count is zero against ROADMAP)
- **THEN** the command SHALL NOT exit non-zero solely for that ROADMAP stamp mismatch
- **AND** release prepare MAY continue to version bump, CI, and release PR creation per other requirements

#### Scenario: Missing release-plan-row does not abort when milestone plan exists

- **WHEN** a matching milestone supplies planned membership for the resolved version
- **AND** `ROADMAP.md` has no `| **vX.Y.Z** |` release-plan row and cannot insert one
- **THEN** the command SHALL NOT abort solely with a `release-plan-row` / `release-plan-none-row` anchor error
- **AND** it MAY warn that ROADMAP documentation was not updated

#### Scenario: Missing shipped-section anchor does not abort when milestone plan exists

- **WHEN** a matching milestone supplies planned membership for the resolved version
- **AND** the ROADMAP `shipped-section` anchor is absent
- **THEN** the command SHALL NOT abort solely for that missing anchor
- **AND** it MAY skip the corresponding ROADMAP mutation with a warning

---

### Requirement: Dry-run SHALL surface milestone presence and open-issue count

Under `--dry-run`, after version resolution, the command SHALL report for the resolved version whether a matching GitHub milestone is present, absent, or unavailable (fetch failed), and when present SHALL report how many **open** non-PR issues that milestone has (total non-PR count MAY also be reported). This report SHALL be printed even when local ROADMAP diffs are also printed.

Dry-run MAY perform a **read-only** GitHub milestone lookup for that report. Dry-run SHALL still write no release-managed files, create no commit, and open no pull request. Dry-run SHALL NOT abort solely because the milestone is absent or the fetch failed; it SHALL label the status clearly and continue the local preview.

#### Scenario: Dry-run reports present milestone and open count

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** a matching milestone exists with 3 open non-PR issues
- **THEN** stdout SHALL indicate the milestone is present for `1.36.0`
- **AND** SHALL report open issue count `3`
- **AND** no release-managed file SHALL be modified

#### Scenario: Dry-run reports absent milestone without aborting

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** no matching milestone exists
- **THEN** stdout SHALL indicate the milestone is absent for `1.36.0`
- **AND** the command SHALL NOT exit non-zero solely for that absence
- **AND** no release-managed file SHALL be modified

#### Scenario: Dry-run reports unavailable milestone when fetch fails

- **WHEN** `pipeline release 1.36.0 --dry-run` runs
- **AND** the read-only milestone lookup fails (network, auth, or API error)
- **THEN** stdout SHALL indicate milestone status is unavailable (or equivalent)
- **AND** the command SHALL NOT invent planned membership
- **AND** local version/ROADMAP diff preview MAY still print

---

### Requirement: Release theme resolution SHALL prefer CLI then milestone without ROADMAP authority

When composing the release theme used for PR title and optional ROADMAP documentation columns, the command SHALL resolve theme in this order: (1) CLI `--theme` when provided and non-empty after trim; (2) documented extraction from the matching milestone title when a milestone is available; (3) a documented placeholder. The command SHALL NOT require a ROADMAP release-plan Theme cell for a successful prepare, and SHALL NOT treat that cell as higher priority than CLI or milestone sources.

#### Scenario: CLI theme wins over milestone

- **WHEN** the operator passes `--theme "Factory reliability"`
- **AND** a matching milestone title would yield a different theme string
- **THEN** the release theme SHALL be `Factory reliability`

#### Scenario: Milestone theme used when CLI theme is absent

- **WHEN** no `--theme` flag is provided
- **AND** a matching GitHub milestone is available
- **THEN** the release theme SHALL be derived from that milestone title by the documented extraction rule

#### Scenario: Placeholder when neither CLI nor milestone theme exists

- **WHEN** no `--theme` is provided
- **AND** no matching milestone is available on the path that still composes a theme (for example dry-run with absent milestone)
- **THEN** the theme SHALL be the documented placeholder rather than an empty silent string

### Requirement: Factory-release prepare SHALL NOT merge, tag, promote, or skip FRG

`pipeline factory-release prepare` SHALL grant no merge, tag, publication, pin
promotion, install, rollback, or Tugboat `--skip-frg` authority on any
protocol tick. An in-progress or failed pack loop SHALL NOT flip those
controls.

#### Scenario: In-progress tick does not gain ship authority

- **WHEN** prepare returns `status: "in_progress"` after dispatching the bound
  pack loop
- **THEN** the command SHALL NOT merge, tag, publish, promote, install, or set
  `--skip-frg`

### Requirement: Ship-end composers SHALL invoke candidate release ensure-tag after finish

Ship-end composers (Tugboat, the installed `pipeline-ship-playbook` launcher, and in-engine `pipeline ship`) SHALL invoke `pipeline release ensure-tag` from the candidate engine after a merged release PR and before publication wait. They SHALL NOT invoke `git tag` or `gh release create`. They SHALL NOT treat auto-tag-release as a substitute when `.agent-pipeline/frg/` is gitignored. `pipeline release finish` SHALL NOT itself tag.

#### Scenario: Tugboat calls ensure-tag not git tag

- **WHEN** Tugboat has merged the `1.39.5` release PR via `release finish`
- **THEN** it SHALL invoke candidate `pipeline release ensure-tag 1.39.5 <mergeCommitOid>`
- **AND** it SHALL NOT invoke `git tag`

### Requirement: Live release prepare SHALL NOT stage Factory Reliability Gate evidence files

The live `pipeline release` path SHALL NOT pass `.agent-pipeline/frg` or any path under that tree as an explicit `git add` pathspec, including `git add -f`. This holds when a Factory Reliability Gate (FRG) pass artifact is present. On-disk `.agent-pipeline/frg/<X.Y.Z>/latest.json` SHALL remain the release-eligible lookup (`pass: true`, HMAC bound to the candidate SHA). Missing, unbound, `pass: false`, or unparsable evidence SHALL still fail-close. `--skip-frg` SHALL NOT be the product fix. The release commit SHALL contain living release-managed product files only (version bumps, ROADMAP, plugin mirror).

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

### Requirement: Failed staging or commit after release-branch creation SHALL restore the configured base

The live `pipeline release` path SHALL restore the configured base branch (`base_branch` from `.github/pipeline.yml`, default `main`) when `git add` or `git commit` fails after local branch `release/vX.Y.Z` exists and before a successful release commit exists on that branch. The command SHALL restore release-managed files (`package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, `.claude-plugin/`) to their pre-release HEAD contents in both the index and the working tree. It SHALL NOT leave HEAD on `release/vX.Y.Z`. It SHALL NOT leave uncommitted version bumps in the index or the working tree. It SHALL delete the local `release/vX.Y.Z` branch when that branch has no unique commit, so a retry can create it again. On-disk `.agent-pipeline/frg/` files SHALL remain. A successful release commit SHALL end this restore duty; a later push failure is out of scope.

#### Scenario: git add of ignored FRG restores the base

- **WHEN** `pipeline release 1.39.5 --no-edit` has created `release/v1.39.5`
- **AND** `git add` exits non-zero because a pathspec is gitignored
- **THEN** HEAD SHALL be the configured base branch (default `main`)
- **AND** `package.json` and `core/package.json` SHALL match their pre-release versions
- **AND** HEAD SHALL NOT be `release/v1.39.5`
- **AND** on-disk `.agent-pipeline/frg/1.39.5/latest.json` SHALL still exist if it existed before the failure

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
