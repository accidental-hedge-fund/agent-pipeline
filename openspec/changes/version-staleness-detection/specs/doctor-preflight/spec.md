## MODIFIED Requirements

### Requirement: The doctor command SHALL check required CLIs, GitHub auth, repo access, worktree cleanliness, harness availability, package install state, optional OpenSpec availability, optional eval command availability, and install version coherence

The set of preflight checks SHALL include, at minimum:

1. **Required CLIs**: `gh` and `node` are executable and on `PATH`.
2. **GitHub auth**: `gh auth status` exits 0 (valid token present).
3. **Repo access**: `gh repo view <configured-repo>` exits 0 (token has access to the target repo).
4. **Worktree cleanliness**: the active working tree has no uncommitted changes on a protected branch (main/staging).
5. **Harness availability**: each harness declared in config (e.g. `claude`, `codex`) is executable on `PATH`.
6. **Package install state** (conditional): for repos with a `package-lock.json` at the repo root, `node_modules` exists and the lock file is not newer than `node_modules` (mtime heuristic). Repos without a root lock file skip this check.
7. **OpenSpec availability** (conditional): when OpenSpec is active for the repo (`openspec.enabled: on`, or `auto` with an `openspec/` directory present), the `openspec` CLI is present and executable.
8. **Eval command availability** (conditional): when the eval gate is enabled with a configured command (`eval_gate.enabled: true` and `eval_gate.command` set), the command's binary is present on `PATH`.
9. **Install version coherence**: the `VERSION` constant loaded by the running `pipeline.ts` at startup matches the `version` field in `core/package.json` at the install root. The check detail SHALL include the version string and install path even when passing, so users can identify which install is active.

#### Scenario: Required CLI missing

- **WHEN** `gh` or `node` is not found on `PATH`
- **THEN** the CLI check for that binary SHALL fail
- **AND** the remediation text SHALL name the missing binary and instruct the user how to install it

#### Scenario: GitHub auth expired

- **WHEN** `gh auth status` exits non-zero
- **THEN** the GitHub auth check SHALL fail
- **AND** the remediation text SHALL instruct the user to run `gh auth login`

#### Scenario: Repo access denied

- **WHEN** `gh repo view <repo>` exits non-zero
- **THEN** the repo-access check SHALL fail
- **AND** the remediation text SHALL name the repo and instruct the user to verify their GitHub token scopes

#### Scenario: Package install state stale

- **WHEN** a `package-lock.json` exists at the repo root and either `node_modules` does not exist or the lock file is newer than `node_modules`
- **THEN** the package install check SHALL fail
- **AND** the remediation text SHALL instruct the user to run `npm ci`

#### Scenario: OpenSpec check skipped when OpenSpec is not active

- **WHEN** OpenSpec is not active for the repo (`openspec.enabled: off`, or `auto` with no `openspec/` directory)
- **THEN** the OpenSpec CLI check SHALL be skipped and SHALL NOT appear as a failure

#### Scenario: Eval command check skipped when not configured

- **WHEN** the eval gate is disabled or no `eval_gate.command` is configured
- **THEN** the eval-command check SHALL be skipped and SHALL NOT appear as a failure

#### Scenario: Install version coherence passes and detail includes install path

- **WHEN** the `VERSION` constant equals the `version` field in `core/package.json` at the install root
- **THEN** the `install:version-coherence` check SHALL have status `"pass"`
- **AND** the detail string SHALL include the version string and the install root path

#### Scenario: Install version coherence fails when versions disagree

- **WHEN** the `VERSION` constant does not equal the `version` field in `core/package.json` at the install root
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the remediation text SHALL instruct the user to reinstall the pipeline skill

## MODIFIED Requirements

### Requirement: Preflight checks SHALL use injectable deps and be unit-testable without real I/O

The doctor module SHALL accept a `DoctorDeps` parameter (or equivalent seam) providing thin I/O primitives (`execCheck`, `fsExists`, `readTextFile`, `fileMtime`). Unit tests SHALL inject fakes through this seam and SHALL perform no real subprocess, filesystem, or network calls. The `DoctorDeps` interface SHALL include `readTextFile(p: string): Promise<string | null>` returning file contents on success or `null` on any error.

#### Scenario: All checks pass with fake deps returning success

- **WHEN** all `DoctorDeps` fakes return passing results
- **THEN** `runPreflight` SHALL return an all-passing result object

#### Scenario: One check fails with fake deps returning failure for that check

- **WHEN** one `DoctorDeps` fake returns a failing result for a single check
- **THEN** `runPreflight` SHALL return a result object with that check marked as failing and the others as passing

#### Scenario: readTextFile fake returns null — install:version-coherence fails

- **WHEN** the `DoctorDeps.readTextFile` fake returns `null` (simulating an unreadable `core/package.json`)
- **THEN** the `install:version-coherence` check SHALL have status `"fail"`
- **AND** the remediation text SHALL instruct the user to reinstall
