## ADDED Requirements

### Requirement: The pipeline SHALL expose a `doctor` command that runs all preflight checks

The pipeline CLI SHALL expose a `doctor` subcommand. When invoked, it SHALL run every declared preflight check, collect results, print a per-check pass/fail summary with remediation text for each failing check, and exit with code 0 when all checks pass or code 1 when any check fails. The checks SHALL be deterministic and SHALL NOT invoke a language model.

#### Scenario: All checks pass — doctor exits 0

- **WHEN** `pipeline doctor` is run and every check returns a passing result
- **THEN** the command SHALL print a summary listing each check as passing
- **AND** SHALL exit with code 0

#### Scenario: One or more checks fail — doctor exits 1 with remediation

- **WHEN** `pipeline doctor` is run and at least one check returns a failing result
- **THEN** the command SHALL print a summary listing each check's result
- **AND** each failing check SHALL include at least one sentence of actionable remediation text describing the corrective action
- **AND** SHALL exit with code 1

#### Scenario: Doctor performs no model calls

- **WHEN** `pipeline doctor` is invoked under any circumstances
- **THEN** it SHALL NOT invoke a language model or consume inference tokens

### Requirement: The doctor command SHALL check required CLIs, GitHub auth, repo access, worktree cleanliness, harness availability, package install state, optional OpenSpec availability, and optional eval command availability

The set of preflight checks SHALL include, at minimum:

1. **Required CLIs**: `gh` and `node` are executable and on `PATH`.
2. **GitHub auth**: `gh auth status` exits 0 (valid token present).
3. **Repo access**: `gh repo view <configured-repo>` exits 0 (token has access to the target repo).
4. **Worktree cleanliness**: the active working tree has no uncommitted changes on a protected branch (main/staging).
5. **Harness availability**: each harness declared in config (e.g. `claude`, `codex`) is executable on `PATH`.
6. **Package install state** (conditional): for repos with a `package-lock.json` at the repo root, `node_modules` exists and the lock file is not newer than `node_modules` (mtime heuristic). Repos without a root lock file skip this check.
7. **OpenSpec availability** (conditional): when OpenSpec is active for the repo (`openspec.enabled: on`, or `auto` with an `openspec/` directory present), the `openspec` CLI is present and executable.
8. **Eval command availability** (conditional): when the eval gate is enabled with a configured command (`eval_gate.enabled: true` and `eval_gate.command` set), the command's binary is present on `PATH`.

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

### Requirement: The pipeline SHALL support an opt-in run-start preflight that blocks the run on failure

When `doctor.runOnStart: true` is set in config or `--doctor` is passed on the CLI, the pipeline SHALL run the preflight checks before the planning stage begins. If any check fails, the pipeline SHALL print the doctor summary and exit with a non-zero code without entering the planning stage. No planning, implementation, or review tokens SHALL be consumed when the run-start preflight fails.

#### Scenario: Run-start preflight blocks on failure

- **WHEN** `doctor.runOnStart: true` is configured or `--doctor` is passed
- **AND** at least one preflight check fails
- **THEN** the pipeline SHALL print the failing check(s) with remediation text
- **AND** SHALL exit before the planning stage
- **AND** SHALL NOT consume any planning or implementation tokens

#### Scenario: Run-start preflight passes — run proceeds normally

- **WHEN** `doctor.runOnStart: true` is configured or `--doctor` is passed
- **AND** all preflight checks pass
- **THEN** the pipeline SHALL proceed to the planning stage as normal

#### Scenario: Existing runs unaffected when preflight is not enabled

- **WHEN** `doctor.runOnStart` is false or absent
- **AND** `--doctor` is not passed
- **THEN** the pipeline run SHALL behave identically to a run without the doctor feature present
- **AND** no preflight checks SHALL execute

### Requirement: `--status` SHALL surface the latest preflight result when available

When `pipeline --status` is invoked, the output SHALL include the latest preflight result (per-check pass/fail summary and a timestamp) if a result has been stored from a prior `doctor` run. If no prior result exists, `--status` SHALL omit the preflight section without error.

#### Scenario: `--status` shows latest preflight result

- **WHEN** a prior `pipeline doctor` invocation stored a result
- **AND** `pipeline --status` is run
- **THEN** the status output SHALL include the preflight summary and the timestamp of when it was last run

#### Scenario: `--status` omits preflight section when no result exists

- **WHEN** no prior `pipeline doctor` invocation has stored a result
- **AND** `pipeline --status` is run
- **THEN** the status output SHALL not include a preflight section and SHALL NOT error

### Requirement: Preflight checks SHALL use injectable deps and be unit-testable without real I/O

The doctor module SHALL accept a `DoctorDeps` parameter (or equivalent seam) providing thin I/O primitives (`execCheck`, `fsExists`, `readFile`, etc.). Unit tests SHALL inject fakes through this seam and SHALL perform no real subprocess, filesystem, or network calls.

#### Scenario: All checks pass with fake deps returning success

- **WHEN** all `DoctorDeps` fakes return passing results
- **THEN** `runPreflight` SHALL return an all-passing result object

#### Scenario: One check fails with fake deps returning failure for that check

- **WHEN** one `DoctorDeps` fake returns a failing result for a single check
- **THEN** `runPreflight` SHALL return a result object with that check marked as failing and the others as passing
