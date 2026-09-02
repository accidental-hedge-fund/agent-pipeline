# doctor-preflight Specification

## Purpose
TBD - created by archiving change doctor-preflight. Update Purpose after archive.

## Requirements

### Requirement: The pipeline SHALL expose a `doctor` command that runs all preflight checks

The pipeline CLI SHALL expose a `doctor` subcommand. When invoked without `--harness-smoke`, it
SHALL run every declared **static** preflight check, collect results, print a per-check pass/fail
summary with remediation text for each failing check, and exit with code 0 when all checks pass or
code 1 when any check fails. Those static checks SHALL be deterministic and SHALL NOT invoke a
language model or consume inference tokens.

When `--harness-smoke` is passed, doctor SHALL still run the static preflight checks and SHALL
additionally run the opt-in dynamic harness-smoke path defined by the `doctor-harness-smoke`
capability. Dynamic harness smoke MAY invoke language models (approximately one cheap model call
per unique configured treatment) and is an explicit, documented exception to the model-free static
doctor rule. Default doctor (no `--harness-smoke`) remains model-free.

#### Scenario: All checks pass — doctor exits 0

- **WHEN** `pipeline doctor` is run and every check returns a passing result
- **THEN** the command SHALL print a summary listing each check as passing
- **AND** SHALL exit with code 0

#### Scenario: One or more checks fail — doctor exits 1 with remediation

- **WHEN** `pipeline doctor` is run and at least one check returns a failing result
- **THEN** the command SHALL print a summary listing each check's result
- **AND** each failing check SHALL include at least one sentence of actionable remediation text describing the corrective action
- **AND** SHALL exit with code 1

#### Scenario: Default doctor performs no model calls

- **WHEN** `pipeline doctor` is invoked without `--harness-smoke`
- **THEN** it SHALL NOT invoke a language model or consume inference tokens

#### Scenario: Opt-in harness smoke may invoke models

- **WHEN** `pipeline doctor --harness-smoke` is invoked
- **THEN** the static preflight checks SHALL remain model-free
- **AND** the harness-smoke path MAY perform cheap model-consuming canned prompts for configured
  treatments as specified by `doctor-harness-smoke`
- **AND** help or summary text SHALL make that cost expectation visible to the operator

#### Scenario: Fail-fast static failure skips paid harness smoke

- **WHEN** `pipeline doctor --harness-smoke` is invoked with fail-fast enabled
- **AND** a static preflight check fails
- **THEN** doctor SHALL exit non-zero with the static failure results
- **AND** SHALL NOT start the dynamic harness-smoke path (no canned model prompts for treatments)

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

### Requirement: `pipeline doctor --json` SHALL emit a single unfenced JSON object with per-check records

When the `--json` flag is passed to `pipeline doctor`, the CLI SHALL write exactly one JSON object to stdout. The output SHALL NOT be wrapped in a markdown code fence or preceded by prose. The envelope SHALL be valid JSON regardless of whether checks pass or fail — a failing check is encoded inside the envelope, never as non-JSON error output. The `--json` output path SHALL reuse the same check runner (`runPreflight`) already used by the human-prose path; no duplicate check logic is permitted.

#### Scenario: JSON flag produces unfenced JSON

- **WHEN** `pipeline doctor --json` is invoked
- **THEN** stdout SHALL contain exactly one JSON object with no surrounding prose or code fences
- **AND** `JSON.parse(stdout)` SHALL succeed

#### Scenario: Failing checks encoded in envelope, not as non-JSON output

- **WHEN** `pipeline doctor --json` is invoked and one or more checks fail
- **THEN** stdout SHALL still be a valid JSON object
- **AND** the failing checks SHALL appear inside the `checks` array with `"ok": false`
- **AND** no non-JSON bytes SHALL appear on stdout

#### Scenario: `doctor` without `--json` is unchanged

- **WHEN** `pipeline doctor` is invoked without `--json`
- **THEN** stdout SHALL be identical to the pre-change prose output
- **AND** no JSON is emitted

### Requirement: The doctor JSON envelope SHALL include `schema_version`, `status`, and a `checks` array

The JSON object produced by `pipeline doctor --json` SHALL include:

- `schema_version` (string): envelope version identifier, e.g. `"1"`.
- `status` (string): top-level discriminant. Values: `"ok"` (all checks pass or skip),
  `"warnings"` (at least one check is `warn` and no check is `fail`), `"error"` (one or
  more checks `fail`; a `fail` dominates any co-occurring `warn`).
- `checks` (array): one entry per check, each being
  `{ name: string, status: "pass"|"warn"|"fail"|"skip", ok: boolean, reason: string, fix: string }`.
  `status` is the per-check discriminant; `ok` SHALL equal `status !== "fail"` (retained
  for backward compatibility). `reason` describes the check result; `fix` contains the
  actionable command or instruction for a `fail` or `warn` (MAY be an empty string when
  the check is `pass` or `skip`).

The `--json` output path SHALL continue to reuse the same check runner (`runPreflight`)
used by the human-prose path; no duplicate check logic is permitted.

#### Scenario: All checks pass — status is ok

- **WHEN** `pipeline doctor --json` is invoked and all checks pass
- **THEN** `status` SHALL equal `"ok"`
- **AND** every entry in `checks` SHALL have `"ok": true` and `"status": "pass"`

#### Scenario: A warning is present with no failure — status is warnings

- **WHEN** `pipeline doctor --json` is invoked and at least one check is `warn` and no check is `fail`
- **THEN** `status` SHALL equal `"warnings"`
- **AND** the warning check's entry SHALL have `"status": "warn"`, `"ok": true`, and a non-empty `fix`

#### Scenario: One check fails — status is error

- **WHEN** `pipeline doctor --json` is invoked and at least one check fails
- **THEN** `status` SHALL equal `"error"`
- **AND** the failing check's entry SHALL have `"status": "fail"`, `"ok": false`, and a non-empty `fix`

#### Scenario: Each check record includes all required fields

- **WHEN** `pipeline doctor --json` is invoked
- **THEN** every entry in `checks` SHALL have `name`, `status`, `ok`, `reason`, and `fix` fields

### Requirement: `pipeline doctor --json` SHALL exit non-zero when any check fails

When `--json` is active and any check fails, the command SHALL exit with code 1. When all checks pass, it SHALL exit with code 0. This mirrors the behavior of the existing human-prose doctor command.

#### Scenario: Exit 1 on failure

- **WHEN** `pipeline doctor --json` is invoked and one or more checks fail
- **THEN** the process SHALL exit with code 1

#### Scenario: Exit 0 on all-pass

- **WHEN** `pipeline doctor --json` is invoked and all checks pass
- **THEN** the process SHALL exit with code 0

### Requirement: `pipeline doctor --is-ok` SHALL exit 0 or 1 with zero bytes of output

When `--is-ok` is passed to `pipeline doctor`, the command SHALL run all preflight checks and exit with code 0 if all checks pass or code 1 if any check fails. The command SHALL write zero bytes to stdout and zero bytes to stderr. `--is-ok` is mutually exclusive with `--json`; if both are passed, the CLI SHALL exit with an error describing the conflict.

#### Scenario: All checks pass — exit 0 with no output

- **WHEN** `pipeline doctor --is-ok` is invoked and all checks pass
- **THEN** the process SHALL exit with code 0
- **AND** stdout SHALL be empty
- **AND** stderr SHALL be empty

#### Scenario: One check fails — exit 1 with no output

- **WHEN** `pipeline doctor --is-ok` is invoked and at least one check fails
- **THEN** the process SHALL exit with code 1
- **AND** stdout SHALL be empty
- **AND** stderr SHALL be empty

#### Scenario: `--is-ok` and `--json` together are rejected

- **WHEN** `pipeline doctor --is-ok --json` is invoked
- **THEN** the CLI SHALL exit with a non-zero code
- **AND** SHALL print an error message to stderr explaining that the flags are mutually exclusive
- **AND** SHALL NOT run any checks

### Requirement: Doctor JSON output SHALL be covered by unit tests using the injectable deps seam

The `--json` output path SHALL be exercisable through the existing `DoctorDeps` injectable seam. Unit tests SHALL verify the envelope shape, per-check records, and exit-code behavior WITHOUT performing real subprocess, filesystem, or network calls.

#### Scenario: Unit test verifies all-pass JSON envelope

- **WHEN** all `DoctorDeps` fakes return passing results
- **AND** the JSON formatter is invoked
- **THEN** the returned object SHALL have `"status": "ok"` and all `checks` entries with `"ok": true`

#### Scenario: Unit test verifies failing-check JSON envelope

- **WHEN** one `DoctorDeps` fake returns a failing result for a single check
- **AND** the JSON formatter is invoked
- **THEN** the returned object SHALL have `"status": "error"`
- **AND** the failing check's entry SHALL have `"ok": false` and a non-empty `fix` field

### Requirement: The doctor check model SHALL support a non-blocking `warn` status

The doctor check model SHALL support a fourth check status, `warn`, in addition to
`pass`, `fail`, and `skip`. A `warn` result SHALL NOT set `PreflightResult.ok` to false,
SHALL NOT cause a non-zero exit code, and SHALL NOT abort a run-start preflight
(`--doctor` / `doctor.runOnStart`). A `warn` result SHALL carry actionable remediation
text and SHALL render distinctly in the human-readable doctor summary. Only a `fail`
status blocks; `warn` is advisory-only.

#### Scenario: A warn-only preflight passes and exits 0

- **WHEN** `pipeline doctor` runs and at least one check returns `warn` while no check returns `fail`
- **THEN** `PreflightResult.ok` SHALL be true
- **AND** the process SHALL exit with code 0
- **AND** the summary SHALL list the warning check with its remediation text

#### Scenario: A warn does not block a run-start preflight

- **WHEN** `doctor.runOnStart: true` is configured or `--doctor` is passed
- **AND** a preflight check returns `warn` and no check returns `fail`
- **THEN** the pipeline SHALL print the warning
- **AND** SHALL proceed to the planning stage (the warn SHALL NOT abort the run)

#### Scenario: A fail still dominates a co-occurring warn

- **WHEN** `pipeline doctor` runs and one check returns `warn` and another returns `fail`
- **THEN** `PreflightResult.ok` SHALL be false
- **AND** the process SHALL exit with code 1

### Requirement: Doctor SHALL check readiness of every harness adapter the configuration assigns

`pipeline doctor` SHALL include one readiness check per harness adapter that the resolved
configuration assigns to a model-invoking stage. Each check SHALL report, as distinguishable
outcomes, whether the adapter's CLI is missing from `PATH`, present but unauthenticated,
unable to run in headless non-interactive mode, or unable to honor the requested model or
effort. Adapters that no stage assigns SHALL NOT be checked. Each check SHALL carry a stable
identifier naming the adapter, so `pipeline doctor --json` exposes it in the per-check
records like every other check.

#### Scenario: An assigned adapter with a missing CLI fails its check

- **WHEN** the configuration assigns an adapter whose CLI is not on `PATH` and `pipeline doctor` runs
- **THEN** that adapter's readiness check SHALL fail with a message identifying the adapter and the missing CLI

#### Scenario: Unauthenticated and unsupported-setting states are distinguishable

- **WHEN** an assigned adapter's CLI is installed but unauthenticated, or is authenticated but cannot honor the requested model or effort
- **THEN** the check SHALL report an outcome that distinguishes the unauthenticated state from the unsupported-setting state and from the missing-CLI state

#### Scenario: Unassigned adapters are not checked

- **WHEN** the configuration assigns no adapter beyond the profile default and `pipeline doctor` runs
- **THEN** no readiness check SHALL be emitted for the unassigned adapters

#### Scenario: Adapter checks appear in JSON output

- **WHEN** `pipeline doctor --json` runs with an assigned adapter
- **THEN** the `checks` array SHALL contain a record whose identifier names that adapter

### Requirement: Run-start preflight SHALL block a run on an adapter readiness failure

When run-start preflight is enabled, a failing harness-adapter readiness check SHALL abort
the run before the assigned stage's model invocation begins. The pipeline SHALL NOT
substitute a different harness or adapter for the failing one, because substituting would
silently change the harness under evaluation.

#### Scenario: Run-start preflight aborts before the stage runs

- **WHEN** run-start preflight is enabled and an assigned adapter's readiness check fails
- **THEN** the run SHALL abort before the assigned stage invokes a model
- **AND** the stage SHALL NOT be executed on a substitute harness

### Requirement: Adapter readiness checks SHALL be unit-testable without real subprocess or network calls

Harness-adapter readiness checks SHALL run through the existing injectable preflight
dependency seam, so unit tests can simulate every outcome — missing CLI, unauthenticated,
headless unavailable, unsupported model or effort, and ready — using fake executables or
fake execution results, with no real subprocess or network call to any provider.

#### Scenario: Every adapter outcome is simulated through the seam

- **WHEN** the adapter readiness checks are exercised with injected fake execution results
- **THEN** each of the missing, unauthenticated, headless-unavailable, unsupported-setting, and ready outcomes SHALL be reproducible
- **AND** no real subprocess or network call to a provider SHALL be made

### Requirement: Doctor SHALL sweep provably-dead pipeline locks and warn on stale-lock accumulation

`pipeline doctor` SHALL, as a deterministic maintenance action, sweep `/tmp/pipeline-*.lock` files
whose recorded PID is provably dead (`ESRCH`) or whose contents hold no parseable PID, using the same
liveness semantics `PipelineLock` and the installer's live-run scan apply. It SHALL NOT remove a lock
whose PID is live, nor one that exists but cannot be signalled (`EPERM`, treated conservatively as
live). Doctor SHALL additionally expose a non-blocking `warn` check that surfaces when many stale
pipeline locks have accumulated, so `/tmp` housekeeping does not depend on an `install.mjs update`
ever running. The sweep and the check SHALL remain deterministic and SHALL NOT invoke a language
model, and SHALL be driven through doctor's injectable deps seam so they are unit-testable without
real process signals or real lock files.

#### Scenario: Doctor sweeps a dead-PID lock

- **WHEN** `pipeline doctor` runs and a `/tmp/pipeline-*.lock` records a PID that no longer exists
- **THEN** doctor SHALL unlink that lock file

#### Scenario: Doctor never sweeps a live or unsignalable lock

- **WHEN** a `/tmp/pipeline-*.lock` records a live PID, or a PID that exists but cannot be signalled
  (`EPERM`)
- **THEN** doctor SHALL NOT unlink it

#### Scenario: Doctor warns when stale locks have accumulated

- **WHEN** the number of stale pipeline locks observed exceeds the accumulation threshold
- **THEN** doctor SHALL report a non-blocking `warn` naming the count
- **AND** the `warn` SHALL NOT change doctor's overall pass/fail exit code

#### Scenario: The sweep and warn are unit-testable through the deps seam

- **WHEN** doctor's lock sweep is driven with a fake lock listing and a fake liveness probe
- **THEN** it SHALL unlink exactly the fakes reported dead or unparseable and warn per the injected
  count
- **AND** SHALL perform no real filesystem or process-signal call beyond the injected seams

### Requirement: Doctor SHALL check run-store write path and recent write-health

The doctor preflight check set SHALL include a deterministic **run-store write-health** check that
does not invoke a language model. The check SHALL fail when either (1) the resolved repository's
run-store parent path (`.agent-pipeline/runs` under the repo root, when resolvable) is not writable,
or (2) a bounded scan of recent run directories finds elevated write-health (one or more recorded
append failures). On failure the check SHALL print remediation text that names the problem (disk
permissions, full filesystem, exclusive sink loss, or incomplete evidence) and instructs the
operator how to investigate. A failing check SHALL cause `pipeline doctor` to exit non-zero in
accordance with the existing doctor pass/fail contract. When the run-store path cannot be resolved
and no recent runs are available, the check SHALL pass or skip without inventing failures.

#### Scenario: Unwritable run-store path fails doctor

- **WHEN** `pipeline doctor` runs and the resolved `.agent-pipeline/runs` parent path is not
  writable
- **THEN** the run-store write-health check SHALL fail
- **AND** remediation text SHALL mention permissions or disk space
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Recent elevated write-health fails doctor

- **WHEN** `pipeline doctor` runs and a bounded recent run directory has elevated write-health
- **THEN** the run-store write-health check SHALL fail
- **AND** remediation text SHALL mention incomplete event evidence or sink/local write failure
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Healthy recent runs pass the check

- **WHEN** `pipeline doctor` runs and the run-store path is writable
- **AND** the bounded recent scan finds no elevated write-health
- **THEN** the run-store write-health check SHALL pass
- **AND** it SHALL NOT cause doctor to fail solely for this reason

### Requirement: Doctor harness-adapter checks SHALL iterate the runtime registry and assigned adapters

Doctor and run-start preflight checks that assess local-CLI harness readiness SHALL determine which
adapters to check from configuration assignment and the runtime adapter registry, not from a
hardcoded closed list of built-in harness names. When configuration assigns an extension adapter
as implementer or reviewer, doctor SHALL run that adapter's declared readiness / smoke / preflight
hooks. When configuration assigns only a subset of registered adapters, doctor SHALL still be able
to report readiness for those assigned adapters without requiring the adapter ID to be one of the
historical built-in names.

#### Scenario: Assigned extension adapter is included in doctor checks

- **WHEN** configuration assigns registered extension adapter `ext-demo` as implementer
- **AND** `pipeline doctor` runs
- **THEN** doctor SHALL include readiness checks for `ext-demo`
- **AND** a missing CLI for `ext-demo` SHALL fail doctor with remediation naming that adapter

#### Scenario: Doctor does not hardcode only claude and codex as harnesses

- **WHEN** registered adapters include built-ins plus at least one extension adapter and
  configuration assigns a non-claude/non-codex adapter
- **THEN** doctor harness checks SHALL not skip that adapter solely because its name is absent
  from a hardcoded `claude`/`codex` (or five-built-in) list

#### Scenario: Unassigned adapters may be skipped without failing doctor

- **WHEN** an adapter is registered but not assigned by the active configuration
- **THEN** doctor MAY skip deep readiness checks for that unassigned adapter
- **AND** skipping an unassigned adapter SHALL NOT by itself cause doctor to fail

### Requirement: Doctor SHALL report assigned adapters’ prompt-delivery byte limits and fail on incoherent declarations

`pipeline doctor` (and run-start preflight when enabled) SHALL, for each local-CLI harness adapter
assigned by the active configuration as implementer or reviewer, report that adapter’s declared
prompt-delivery channel and `maxPromptBytes` capability (finite byte limit, unlimited, or unknown)
in the per-check summary and in machine-readable `--json` output.

Doctor SHALL fail a dedicated check when an assigned adapter:

- omits `maxPromptBytes`,
- declares `unknown` while assigned to a production role,
- or declares an incoherent channel and limit pair (for example argv/positional delivery with
  unlimited, or a declaration size/limit policy that disagrees with `maxPromptBytes`).

On failure the check SHALL print remediation that names the adapter and instructs the operator how
to fix the declaration or reassign to a stdin- or file-capable adapter. A failing check SHALL cause
`pipeline doctor` to exit non-zero in accordance with the existing doctor pass/fail contract.

When an assigned adapter declares a finite argv-bound limit, doctor SHALL include remediation text
that production review and fix prompts commonly exceed the OS per-argument ceiling (~128 KiB), so
operators learn the hard ceiling before the first large-context stage failure. Doctor SHALL NOT
require materializing a full stage prompt to satisfy this requirement.

Unassigned adapters MAY be skipped for deep readiness checks under existing unassigned-adapter
rules; skipping an unassigned adapter solely because it is unassigned SHALL NOT by itself fail
doctor.

#### Scenario: Doctor reports delivery channel and maxPromptBytes for assigned adapters

- **WHEN** configuration assigns adapters as implementer and/or reviewer
- **AND** `pipeline doctor` runs
- **THEN** the summary SHALL include each assigned adapter’s prompt-delivery channel and
  `maxPromptBytes` value
- **AND** `pipeline doctor --json` SHALL expose the same data on the corresponding check records

#### Scenario: Missing or unknown maxPromptBytes on an assigned adapter fails doctor

- **WHEN** an assigned adapter omits `maxPromptBytes` or declares unknown
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the adapter
- **AND** doctor SHALL exit with code 1 when any check fails

#### Scenario: Incoherent argv and unlimited pair fails doctor

- **WHEN** an assigned adapter declares positional/`argv` prompt delivery together with unlimited
  `maxPromptBytes` (or an equivalent incoherent declaration size/limit policy)
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the incoherence

#### Scenario: Argv finite limit above spawnable ceiling fails doctor

- **WHEN** an assigned adapter declares positional/`argv` prompt delivery together with a finite
  `maxPromptBytes` greater than the harness spawnable argv ceiling
- **AND** `pipeline doctor` runs
- **THEN** the prompt-limit coherence check SHALL fail
- **AND** remediation SHALL name the adapter and the unspawnable limit

#### Scenario: Finite argv-bound assignment includes large-prompt remediation

- **WHEN** an assigned adapter declares finite argv-bound `maxPromptBytes`
- **AND** `pipeline doctor` runs
- **THEN** doctor output for that adapter SHALL include remediation noting that production
  review/fix prompts commonly exceed the ~128 KiB per-argument ceiling

#### Scenario: Run-start preflight blocks on prompt-limit coherence failure

- **WHEN** run-start preflight is enabled
- **AND** an assigned adapter fails the prompt-limit coherence check
- **THEN** the run SHALL abort before the assigned stage invokes a model
- **AND** the stage SHALL NOT be executed on a substitute harness

### Requirement: Doctor SHALL admit and report the configured git push-auth mechanism

`pipeline doctor` SHALL include a preflight check that admits the resolved git push-auth configuration. The check SHALL report the resolved mechanism (`ssh` or `https-token`) and, for `https-token`, the configured environment-variable **name** without printing the secret value. When the mechanism is `https-token` and the named environment variable is unset or empty, the check SHALL **fail** with an operator-actionable message that names the missing variable. When the mechanism is `ssh`, the check SHALL **pass** for configuration admission of the default SSH mechanism (without requiring a PAT `workflow` scope). The check SHALL be unit-testable via the doctor injectable deps seam without performing a real network git push.

#### Scenario: doctor reports SSH mechanism

- **WHEN** the resolved push-auth mechanism is `ssh` and the operator runs `pipeline doctor`
- **THEN** the doctor results SHALL include a check that reports mechanism `ssh`
- **AND** that check SHALL pass for configuration admission of SSH

#### Scenario: doctor fails when HTTPS-token env var is missing

- **WHEN** the resolved push-auth mechanism is `https-token` with token environment name `GITHUB_PUSH_TOKEN` and that variable is unset or empty
- **AND** the operator runs `pipeline doctor`
- **THEN** the doctor check for push-auth SHALL fail
- **AND** the failure message SHALL name `GITHUB_PUSH_TOKEN`
- **AND** the failure message SHALL NOT include a secret token value

#### Scenario: doctor passes when HTTPS-token env var is present

- **WHEN** the resolved push-auth mechanism is `https-token` with token environment name `GITHUB_PUSH_TOKEN` and that variable is set to a non-empty value
- **AND** the operator runs `pipeline doctor`
- **THEN** the doctor check for push-auth SHALL pass configuration readiness for the named env var’s presence
- **AND** doctor output SHALL NOT print the variable’s secret value

#### Scenario: push-auth doctor check is unit-testable without network push

- **WHEN** unit tests exercise the push-auth doctor check with injectable deps
- **THEN** the tests SHALL assert pass/fail outcomes for `ssh` and for `https-token` with set vs unset env
- **AND** the tests SHALL NOT require a real git push or GitHub network call

### Requirement: Assigned-harness pass copy SHALL report credentials or login-status present, not verified authentication

Assigned-harness doctor checks SHALL keep using the adapter’s static preflight or runtimeSmoke result as the model-free signal. When that result is ok, the human-readable pass detail, the check description, and the JSON `reason` SHALL state that credentials or login-status are present. They SHALL NOT use the words authenticated, authentication verified, or equivalent claims that a live session probe succeeded. Default `pipeline doctor` without `--harness-smoke` SHALL remain model-free. A fail that the adapter reports as `unauthenticated` SHALL stay distinguishable from missing-CLI and unsupported-setting. Fail remediation MAY instruct the operator to authenticate.

#### Scenario: Passing harness check does not claim live authentication

- **WHEN** an assigned adapter’s static preflight returns ok and `pipeline doctor` runs without `--harness-smoke`
- **THEN** that check SHALL pass
- **AND** the human summary and JSON `reason` SHALL mention credentials or login-status present
- **AND** the pass detail, check description, and JSON `reason` SHALL NOT contain `authenticated` or `verified authentication`

#### Scenario: Default doctor still makes no model call

- **WHEN** `pipeline doctor` is invoked without `--harness-smoke`
- **THEN** it SHALL NOT invoke a language model or consume inference tokens

#### Scenario: Unauthenticated fail remains distinct

- **WHEN** an assigned adapter’s static preflight returns not-ok with failure class `unauthenticated`
- **THEN** the harness check SHALL fail
- **AND** the outcome SHALL be distinguishable from missing-CLI and from unsupported-setting
- **AND** remediation MAY instruct the operator to authenticate that CLI

#### Scenario: Pass-copy honesty is unit-testable without a live probe

- **WHEN** unit tests drive assigned-harness checks through the doctor injectable deps seam with a fake preflight ok result
- **THEN** they SHALL assert the pass wording contract above
- **AND** SHALL perform no real subprocess, filesystem, or network call to a provider

### Requirement: Doctor SHALL report continuous-liveness status without projecting human authority

`pipeline doctor` SHALL include a deterministic continuous-liveness check that does not invoke a language model. The check SHALL report whether a Liveness Provider keep-alive path is `configured`, `available`, `active`, or `degraded` / `unavailable`. Unavailable or unconfigured continuous liveness SHALL be a typed capability condition. It SHALL NOT be classified as human authority, a Decision Request, or a needs-human hold. Absence of systemd, launchd, a container supervisor, or a harness worker SHALL NOT fail doctor as if a person must own the run. A configured adapter that is incoherent or broken MAY fail or warn as `degraded` with remediation that names the adapter, not a human-authority class. `pipeline doctor --json` SHALL expose the same discriminant on the check record.

#### Scenario: Unconfigured keep-alive is a capability condition, not a human hold

- **WHEN** `pipeline doctor` runs on a one-shot CLI host with no keep-alive adapter configured
- **THEN** the continuous-liveness check SHALL report `unavailable` or not-configured
- **AND** the reason SHALL be a typed capability condition
- **AND** the summary SHALL NOT use human-authority or needs-human language
- **AND** that absence SHALL NOT by itself cause doctor to fail

#### Scenario: Active worker is reported active

- **WHEN** a keep-alive adapter is configured and a fenced supervisor is live
- **THEN** the check SHALL report `active`
- **AND** `pipeline doctor --json` SHALL include that discriminant on the check record

#### Scenario: Configured but broken adapter is degraded

- **WHEN** a keep-alive adapter is configured and cannot claim a fence or probe identity
- **THEN** the check SHALL report `degraded` or `unavailable`
- **AND** remediation SHALL name the adapter and the typed capability condition
- **AND** the check SHALL NOT describe the fault as a human decision

#### Scenario: The check is unit-testable through doctor deps

- **WHEN** unit tests drive the continuous-liveness check with injected adapter and identity fakes
- **THEN** they SHALL assert `configured`, `available`, `active`, and `degraded` / `unavailable` outcomes
- **AND** they SHALL perform no real systemd, launchd, container, network, git, or subprocess call
