## Context

`config.ts` already defines `PartialConfigSchema` (Zod) and `resolveConfig()`, which throws on any invalid value. Pipeline Desk needs a way to validate `.github/pipeline.yml` before saving and to offer schema-driven autocomplete — without importing TypeScript or duplicating the Zod schema. Two CLI subcommands (`config schema`, `config validate`) expose the engine's existing contract as a desktop-friendly surface.

## Goals / Non-Goals

**Goals**
- JSON Schema output is always structurally consistent with `PartialConfigSchema` (cannot drift).
- The validate command never throws; all outcomes are structured JSON on stdout.
- Severity tiering: rigor/cost-gating misconfigs are `error` (exit 1), not coerced silently.
- Existing `resolveConfig()` behaviour is completely unchanged.

**Non-Goals**
- Line-number precision for every field-level Zod error (YAML syntax errors carry line numbers; Zod errors carry paths; a full CST-based position map would require replacing `js-yaml` with a CST-aware parser and is out of scope).
- A live watch/re-validate mode.
- Schema distribution as an npm package or over a URL (commands are the delivery mechanism).

## Decisions

**Decision: derive JSON Schema at runtime from the Zod schema using `zod-to-json-schema`.**
Adding `.describe("…")` annotations to each field in `PartialConfigSchema` gives the JSON Schema human-readable descriptions that appear as tooltips in editors. Generating at runtime (not a static JSON file) means the schema can never drift from the Zod source. `zod-to-json-schema` is a pure-JS package with no runtime side-effects; adding it as a `dependency` (not dev-only) is correct because `config schema` is a runtime command. A snapshot test validates the generated schema shape against known fields.

**Decision: `validateConfig(repoPath: string, deps: ValidateConfigDeps): ValidateConfigResult` — a parallel, never-throws entry-point.**
`resolveConfig()` is caller-throws-or-succeeds. `validateConfig()` returns `{ valid: boolean, diagnostics: Diagnostic[] }`. It re-uses the same Zod schema but catches all Zod errors and maps them to `Diagnostic` objects rather than re-throwing. This is the pattern from gstack `host-config.ts` (`string[]` return, caller picks exit code).

**Decision: classify rigor/cost-gating paths as `error`; everything else also `error` (strict-open), with `warning` reserved for inert-setting conditions only.**
The tiering from the issue sharpens to: all schema violations (wrong type, unknown key, bad enum) are `error`; the only `warning` class is the already-existing inert-alias detection (models set for a codex-backed role). This matches the existing `resolveConfig()` fail-loud contract. A future issue could promote more conditions to `warning`; this change does not introduce any new coerce-on-warning paths.

**Rigor-gating path list (hardcoded, not config-driven):**
```
review_policy.block_threshold
review_policy.min_confidence
review_policy.max_adversarial_rounds
steps.standard_review
steps.adversarial_review
steps.plan_review
eval_gate.enabled
eval_gate.mode
shipcheck_gate.enabled
shipcheck_gate.mode
```
These are the fields whose misconfig changes review coverage or paid-call volume. The list lives as a constant in `config.ts` alongside the schema. The validate command annotates diagnostics for these paths with a `rigorGating: true` marker so the caller can distinguish them.

**Decision: line numbers are best-effort.**
`js-yaml`'s `load()` with `{ filename }` gives a `YAMLException` with `.mark.line` on parse failure. Zod's `.issues` give `.path` (array of keys) but no source position. The `Diagnostic` type has `line?: number` — present for YAML syntax errors, absent for Zod field errors. Callers (Pipeline Desk) display the path as the field locator when `line` is absent.

**Decision: `--repo-path` defaults to cwd; `--json` is the only output format for diagnostics.**
The validate subcommand always prints JSON when `--json` is passed; without it, it prints a human-readable summary (one line per diagnostic). The `config schema` command always prints JSON (no flag needed). This matches the `gh --json` pattern used elsewhere in the codebase.

**Decision: deps/fake seam pattern for `validateConfig()`.**
`validateConfig()` takes a `ValidateConfigDeps` parameter (`{ readFile, findGitRoot, getInertModelPaths }`) so unit tests inject fakes for file I/O, git-root resolution, and the inert-model detection logic. No real filesystem or subprocess calls in tests.

## Risks / Trade-offs

- *`zod-to-json-schema` diverges from Zod output on edge cases*: mitigated by the snapshot test that asserts known top-level keys appear with correct types and enums.
- *Rigor-gating path list grows stale as new keys are added*: the list is tested — a test asserts that every path in the list actually exists in the generated JSON Schema, so a deleted/renamed key fails CI.
- *`validateConfig()` and `resolveConfig()` could diverge over time*: the integration test exercises both on the same YAML input and asserts consistent outcomes for the non-throwing cases.
