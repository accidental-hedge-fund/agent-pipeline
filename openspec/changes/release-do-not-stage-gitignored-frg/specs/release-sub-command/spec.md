## ADDED Requirements

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

The live `pipeline release` path SHALL restore the configured base branch (`base_branch` from `.github/pipeline.yml`, default `main`) when `git add` or `git commit` fails after local branch `release/vX.Y.Z` exists and before a successful release commit exists on that branch. The command SHALL restore release-managed files (`package.json`, `core/package.json`, `ROADMAP.md`, `plugin/`, `.claude-plugin/`) to their pre-release HEAD contents. It SHALL NOT leave HEAD on `release/vX.Y.Z`. It SHALL NOT leave uncommitted version bumps in the working tree. It SHALL delete the local `release/vX.Y.Z` branch when that branch has no unique commit, so a retry can create it again. On-disk `.agent-pipeline/frg/` files SHALL remain. A successful release commit SHALL end this restore duty; a later push failure is out of scope.

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
- **AND** uncommitted version bumps SHALL NOT remain in the working tree
- **AND** the local `release/v1.39.5` branch SHALL NOT remain if it has no unique commit

#### Scenario: Successful commit is not rolled back by this rule

- **WHEN** `pipeline release` has created a successful release commit on `release/vX.Y.Z`
- **THEN** a later `git push` failure SHALL NOT restore the base under this requirement
- **AND** the local release commit SHALL remain for a later push retry
