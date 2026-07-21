# config-validate-command Specification

## Purpose
TBD - created by archiving change desktop-contract-config-schema-validate. Update Purpose after archive.
## Requirements
### Requirement: `pipeline config validate` emits structured JSON diagnostics and exits with the appropriate code

The `pipeline config validate [--repo-path <path>] [--json]` command SHALL validate the `.github/pipeline.yml` at the resolved git root of `--repo-path` (defaulting to cwd). When `--json` is passed, it SHALL print a JSON object `{ "valid": boolean, "diagnostics": Diagnostic[] }` to stdout. When `--json` is absent, it SHALL print a human-readable summary (one line per diagnostic). The command SHALL exit 1 if any diagnostic has `severity: "error"`; it SHALL exit 0 otherwise. The command SHALL never throw — all outcomes (including unreadable files, YAML parse failures, and Zod validation errors) are returned as diagnostics.

Each `Diagnostic` object SHALL have the shape:
```json
{
  "severity": "error" | "warning",
  "path": "<dotted.field.path or empty string for file-level errors>",
  "message": "<human-readable description>",
  "line": <number | undefined>
}
```

`line` SHALL be present for YAML syntax errors (from the YAML parser's error mark). It SHALL also be populated for Zod field-level validation errors — unrecognized keys and invalid values — whenever the offending key can be located in the source YAML, so a desktop editor can attach the diagnostic to a line (this matters most for rigor/cost-gating misconfigs). It MAY be absent only when the key cannot be located in the source.

#### Scenario: valid config exits 0 with no diagnostics

- **WHEN** `.github/pipeline.yml` exists and passes schema validation
- **THEN** `pipeline config validate --json` SHALL print `{ "valid": true, "diagnostics": [] }`
- **AND** the command SHALL exit 0

#### Scenario: missing config file is an error

- **WHEN** no `.github/pipeline.yml` exists at the resolved git root
- **THEN** `pipeline config validate --json` SHALL print a JSON object with `"valid": false`
- **AND** `diagnostics` SHALL contain one entry with `severity: "error"`, `path: ""`, and a message identifying the missing file
- **AND** the command SHALL exit 1

#### Scenario: invalid YAML syntax is an error with line number

- **WHEN** `.github/pipeline.yml` contains a YAML syntax error
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "error"`, `path: ""`, and `line` set to the offending line number from the YAML parser
- **AND** the command SHALL exit 1

#### Scenario: unknown key is an error

- **WHEN** `.github/pipeline.yml` contains an unrecognized top-level key (e.g. `auto_merge: true`)
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "error"` and `path` identifying the unknown key
- **AND** the diagnostic SHALL include the `line` of the unknown key in the source YAML
- **AND** the command SHALL exit 1

#### Scenario: bad rigor-gating value carries a source line

- **WHEN** `.github/pipeline.yml` sets an invalid value on a rigor-gating path (e.g. `review_policy: { block_threshold: "typo" }`)
- **THEN** the diagnostic SHALL include `rigorGating: true` and the `line` of the offending key in the source YAML

#### Scenario: human-readable output without --json flag

- **WHEN** the user runs `pipeline config validate` without `--json`
- **THEN** the command SHALL print a human-readable summary of findings to stdout
- **AND** exit codes SHALL follow the same rules (1 on any error, 0 otherwise)

### Requirement: Rigor/cost-gating key misconfigs are always severity "error" (exit 1)

For a defined set of rigor/cost-gating paths — `review_policy.block_threshold`, `review_policy.min_confidence`, `review_policy.max_adversarial_rounds`, `steps.standard_review`, `steps.adversarial_review`, `steps.plan_review`, `eval_gate.enabled`, `eval_gate.mode`, `shipcheck_gate.enabled`, `shipcheck_gate.mode` — an invalid value (wrong type, out-of-enum, etc.) SHALL produce a diagnostic with `severity: "error"` and a `rigorGating: true` marker. The command SHALL exit 1. The invalid value SHALL NOT be coerced to a default.

#### Scenario: bad review_policy.block_threshold value is error, not coerced

- **WHEN** `.github/pipeline.yml` sets `review_policy: { block_threshold: "typo" }`
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "error"`, `path: "review_policy.block_threshold"`, and `rigorGating: true`
- **AND** the command SHALL exit 1
- **AND** the diagnostic SHALL NOT contain a coerced or suggested default value for the field

#### Scenario: bad steps.adversarial_review type is error

- **WHEN** `.github/pipeline.yml` sets `steps: { adversarial_review: "yes" }` (non-boolean)
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "error"`, `path: "steps.adversarial_review"`, and `rigorGating: true`
- **AND** the command SHALL exit 1

#### Scenario: bad eval_gate.mode enum value is error

- **WHEN** `.github/pipeline.yml` sets `eval_gate: { mode: "blocking" }` (not in enum)
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "error"`, `path: "eval_gate.mode"`, and `rigorGating: true`
- **AND** the command SHALL exit 1

### Requirement: Inert-setting conditions are severity "warning" and do not cause exit 1

An inert-setting condition — a `models.*` alias explicitly set in `.github/pipeline.yml` when the backing harness role is `codex` (so the alias will be silently ignored at runtime) — SHALL produce a diagnostic with `severity: "warning"`. When inert-setting warnings are the only diagnostics present, the command SHALL exit 0.

#### Scenario: inert models alias produces warning, not error

- **WHEN** `.github/pipeline.yml` explicitly sets `models: { review: "claude-opus-4-8" }` and the active profile's reviewer is `codex`
- **THEN** `pipeline config validate --json` SHALL emit a diagnostic with `severity: "warning"` and `path: "models.review"`
- **AND** `valid` SHALL be `true` in the JSON output
- **AND** the command SHALL exit 0

#### Scenario: warning-only run exits 0

- **WHEN** the config has only inert-setting warnings and no schema errors
- **THEN** `pipeline config validate --json` SHALL print `{ "valid": true, "diagnostics": [...] }` where all diagnostics have `severity: "warning"`
- **AND** the command SHALL exit 0

### Requirement: `validateConfig()` is a never-throws export usable without the CLI

The engine SHALL export a `validateConfig(repoPath: string, deps?: ValidateConfigDeps): ValidateConfigResult` function from `config.ts`. This function SHALL never throw. All error conditions SHALL be returned as structured `Diagnostic` objects in the result. The function's `deps` parameter SHALL accept injectable fakes for `readFile`, `findGitRoot`, and inert-model detection so it can be unit-tested without real filesystem or subprocess calls.

#### Scenario: validateConfig returns structured result on invalid YAML

- **WHEN** `validateConfig()` is called with a repo path whose `pipeline.yml` contains invalid YAML
- **THEN** it SHALL return `{ valid: false, diagnostics: [{ severity: "error", path: "", message: "...", line: <n> }] }`
- **AND** SHALL NOT throw

#### Scenario: validateConfig is independent of resolveConfig

- **WHEN** `validateConfig()` is called on a config that would cause `resolveConfig()` to throw
- **THEN** `validateConfig()` SHALL return a structured result with the error as a diagnostic
- **AND** `resolveConfig()` behaviour SHALL be unchanged (still throws on the same input)

### Requirement: A Claude-only reviewer model alias against a codex reviewer SHALL be a validation error, not a warning

`validateConfig()` SHALL classify an explicitly configured Claude-only reviewer model alias
(`models.review` or `review_harness.model`) as severity `error` when the effective reviewer
harness is `codex`, so `pipeline config validate` exits 1. It SHALL NOT additionally report the
same key as an inert-setting `warning`, which would contradict the error. The diagnostic
message SHALL match the parse-time rejection: key path, rejected value, reviewer harness, and
the valid alternatives (an account-supported OpenAI model id, or `auto`).

#### Scenario: models.review Claude alias with a codex reviewer exits 1

- **WHEN** `pipeline config validate` runs against a config setting `models: { review: sonnet }` with an effective codex reviewer
- **THEN** the diagnostics SHALL include one with `severity: "error"` and `path: "models.review"`
- **AND** the command SHALL exit 1
- **AND** no `warning` diagnostic SHALL be reported for `models.review`

#### Scenario: review_harness.model Claude alias with a codex reviewer exits 1

- **WHEN** `pipeline config validate` runs against a config setting `review_harness: { command: codex, model: haiku }`
- **THEN** the diagnostics SHALL include one with `severity: "error"` and `path: "review_harness.model"`
- **AND** the command SHALL exit 1

#### Scenario: auto reviewer model produces no diagnostic

- **WHEN** `pipeline config validate` runs against a config setting `models: { review: auto }` with an effective codex reviewer
- **THEN** no diagnostic SHALL be reported for `models.review`
- **AND** the command SHALL exit 0

#### Scenario: validateConfig never throws on the rejected alias

- **WHEN** `validateConfig()` is called on a config containing a Claude-only reviewer alias with a codex reviewer
- **THEN** it SHALL return `{ valid: false, diagnostics }` rather than throwing

