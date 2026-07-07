## ADDED Requirements

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

## MODIFIED Requirements

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
