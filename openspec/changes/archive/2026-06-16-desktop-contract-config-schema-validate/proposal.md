## Why

Pipeline Desk ships a `.github/pipeline.yml` editor but has no authoritative contract for valid keys, accepted values, or diagnostics — duplicating schema logic from the engine causes inevitable drift. `agent-pipeline` already owns a Zod schema and full validation logic; exposing two new CLI commands lets Pipeline Desk (and any editor integration) delegate all schema knowledge back to the engine.

## What Changes

- Add `pipeline config schema` subcommand: prints JSON Schema (draft-07) for `.github/pipeline.yml`, derived from `PartialConfigSchema` with field descriptions and enum values.
- Add `pipeline config validate [--repo-path <path>] [--json]` subcommand: validates the config at the given path (defaulting to the cwd git root), emitting structured JSON diagnostics — `{ valid: boolean, diagnostics: Diagnostic[] }` — and exiting with code 0 or 1.
- Diagnostics carry `severity: "error" | "warning"`, `path` (dotted field name), `message`, and best-effort `line` (present for YAML parse errors; path-only for Zod validation errors).
- Severity tiering: rigor/cost-gating keys (`review_policy.block_threshold`, `review_policy.min_confidence`, `review_policy.max_adversarial_rounds`, all `steps.*` toggles, `eval_gate.enabled`, `eval_gate.mode`, `shipcheck_gate.enabled`, `shipcheck_gate.mode`) produce `severity: "error"` and exit 1 on bad values — a typo MUST NOT silently coerce to a default. All other invalid/unknown keys also produce `severity: "error"` (consistent with the engine's existing strict-schema behaviour). Inert-setting conditions (e.g. `models.*` aliases set when the harness is `codex`) produce `severity: "warning"` and do not affect the exit code when they are the only findings.
- `resolveConfig()` is unchanged — it still throws on any invalid value; the new `validateConfig()` is a parallel, never-throws entry-point used only by the new commands.
- README gains a brief section documenting both commands for editor integration authors.

## Capabilities

### New Capabilities

- `config-schema-command`: `pipeline config schema` prints the JSON Schema for `.github/pipeline.yml`, keeping Pipeline Desk thin and schema-in-sync.
- `config-validate-command`: `pipeline config validate [--repo-path <path>] [--json]` produces severity-tiered structured diagnostics without throwing; exit 1 on any `error`-severity finding.

### Modified Capabilities

- `pipeline-configuration`: Document that `PartialConfigSchema` entries for rigor/cost-gating keys (`review_policy.*`, `steps.*`, `eval_gate.enabled/mode`, `shipcheck_gate.enabled/mode`) are designated severity-`error` by the validate command; and that a parallel `validateConfig()` export exists alongside `resolveConfig()`.

## Impact

- `core/scripts/config.ts` — add `validateConfig()` export and severity-tier classification; annotate `PartialConfigSchema` fields with `.describe()` for schema generation.
- `core/scripts/pipeline.ts` — wire `pipeline config schema` and `pipeline config validate` subcommands.
- `core/test/config-validate.test.ts` — new test file covering schema generation and all diagnostic tiers.
- README — new "Editor / Desktop integration" section.
- `plugin/` mirror regenerated after all `core/` changes.

## Acceptance Criteria

- [ ] `pipeline config schema` prints valid JSON Schema to stdout; the schema structurally reflects `PartialConfigSchema` (same keys, types, enums).
- [ ] `pipeline config validate --json` exits 0 and prints `{ valid: true, diagnostics: [] }` when `.github/pipeline.yml` is valid.
- [ ] `pipeline config validate --json` exits 1 and emits a diagnostic with `severity: "error"` and the offending path when a rigor-gating key (`review_policy.block_threshold`, `review_policy.min_confidence`, `steps.standard_review`, etc.) has an invalid value.
- [ ] `pipeline config validate --json` exits 1 with `severity: "error"` on missing config file, invalid YAML, or unknown keys.
- [ ] `pipeline config validate --json` exits 0 with `severity: "warning"` diagnostics when an inert-setting condition (e.g. `models.review` set while harness is `codex`) is detected and no error-severity findings are present.
- [ ] `validateConfig()` never throws; all error conditions are returned as structured diagnostics.
- [ ] Tests cover: schema generation, valid config, rigor-gating bad value, missing file, invalid YAML, unknown key, inert-setting warning.
- [ ] README documents both commands for editor integration authors.
- [ ] `npm run ci` passes (mirror in sync, all tests green).
