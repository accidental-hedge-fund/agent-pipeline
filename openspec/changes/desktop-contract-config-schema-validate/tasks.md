## 1. Add zod-to-json-schema dependency and annotate PartialConfigSchema

- [ ] 1.1 Add `zod-to-json-schema` to `core/package.json` as a runtime dependency.
- [ ] 1.2 Annotate every top-level field in `PartialConfigSchema` (and key sub-fields) with `.describe("<text>")` in `core/scripts/config.ts`.
- [ ] 1.3 Export `RIGOR_GATING_PATHS` constant from `config.ts` with the full list of rigor/cost-gating dotted paths.

## 2. Implement validateConfig()

- [ ] 2.1 Define `Diagnostic`, `ValidateConfigResult`, and `ValidateConfigDeps` types in `config.ts` (or a co-located `config-types.ts`).
- [ ] 2.2 Implement `validateConfig(repoPath: string, deps?: ValidateConfigDeps): ValidateConfigResult` that: finds git root, reads `pipeline.yml`, catches YAML parse errors (with line numbers), runs Zod validation and maps `.issues` to `Diagnostic` objects, classifies `RIGOR_GATING_PATHS` violations as `rigorGating: true`, detects inert-model aliases and maps them to `severity: "warning"` diagnostics.
- [ ] 2.3 Ensure `validateConfig()` never throws — all error paths return `{ valid: false, diagnostics: [...] }`.

## 3. Implement pipeline config schema command

- [ ] 3.1 Add a `generateConfigSchema(): object` function in `config.ts` that calls `zod-to-json-schema` on `PartialConfigSchema` and returns the JSON Schema object.
- [ ] 3.2 Wire `pipeline config schema` subcommand in `core/scripts/pipeline.ts`: call `generateConfigSchema()` and print `JSON.stringify(schema, null, 2)` to stdout; exit 0.

## 4. Implement pipeline config validate command

- [ ] 4.1 Wire `pipeline config validate [--repo-path <path>] [--json]` subcommand in `core/scripts/pipeline.ts`.
- [ ] 4.2 Call `validateConfig()` with the resolved `--repo-path` (default: cwd).
- [ ] 4.3 When `--json` is passed: print `JSON.stringify(result, null, 2)` to stdout; exit 1 if any diagnostic has `severity: "error"`, else exit 0.
- [ ] 4.4 When `--json` is absent: print a human-readable summary (one line per diagnostic with severity prefix); apply the same exit-code rule.

## 5. Tests

- [ ] 5.1 Schema generation: assert generated JSON Schema contains expected top-level keys (`base_branch`, `review_policy`, `steps`, `eval_gate`, `shipcheck_gate`); assert `review_policy.block_threshold` has enum `["critical","high","medium","low"]`; assert all properties have a `description` string.
- [ ] 5.2 Rigor-gating paths test: assert every entry in `RIGOR_GATING_PATHS` resolves to a real property in the generated schema.
- [ ] 5.3 `validateConfig()` — valid config: returns `{ valid: true, diagnostics: [] }`.
- [ ] 5.4 `validateConfig()` — missing file: returns `{ valid: false, diagnostics: [{ severity: "error", path: "", ... }] }`, does not throw.
- [ ] 5.5 `validateConfig()` — invalid YAML: returns error diagnostic with `line` set.
- [ ] 5.6 `validateConfig()` — unknown key: returns `{ valid: false, diagnostics: [{ severity: "error", path: "auto_merge" }] }`.
- [ ] 5.7 `validateConfig()` — rigor-gating bad value: `review_policy.block_threshold: "typo"` → diagnostic with `severity: "error"` and `rigorGating: true`; exit 1 in CLI integration.
- [ ] 5.8 `validateConfig()` — inert-model warning: `models.review` set while reviewer harness is `codex` → diagnostic with `severity: "warning"`; result is `{ valid: true, diagnostics: [...] }`.
- [ ] 5.9 All tests use injected fakes via `ValidateConfigDeps`; no real filesystem or subprocess calls.

## 6. README documentation

- [ ] 6.1 Add an "Editor / Desktop integration" section to `README.md` documenting `pipeline config schema` and `pipeline config validate --repo-path <path> --json`, including the `Diagnostic` JSON shape and exit-code semantics.

## 7. Mirror regeneration and CI gate

- [ ] 7.1 Run `node scripts/build.mjs` to regenerate `plugin/` after all `core/` changes.
- [ ] 7.2 Run `npm run ci` from the repo root and confirm all checks pass (tests, mirror sync, install smoke).
