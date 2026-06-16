## ADDED Requirements

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
- `status` (string): top-level discriminant. Values: `"ok"` (all checks pass), `"warnings"` (reserved for future use), `"error"` (one or more checks fail).
- `checks` (array): one entry per check, each being `{ name: string, ok: boolean, reason: string, fix: string }`. `reason` describes the check result; `fix` contains the actionable command or instruction to resolve a failing check (MAY be an empty string when `ok` is true).

#### Scenario: All checks pass — status is ok

- **WHEN** `pipeline doctor --json` is invoked and all checks pass
- **THEN** `status` SHALL equal `"ok"`
- **AND** every entry in `checks` SHALL have `"ok": true`

#### Scenario: One check fails — status is error

- **WHEN** `pipeline doctor --json` is invoked and at least one check fails
- **THEN** `status` SHALL equal `"error"`
- **AND** the failing check's entry SHALL have `"ok": false`
- **AND** that entry's `fix` field SHALL be non-empty, containing the remediation command

#### Scenario: Each check record includes all required fields

- **WHEN** `pipeline doctor --json` is invoked
- **THEN** every entry in `checks` SHALL have `name`, `ok`, `reason`, and `fix` fields

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
