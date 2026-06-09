## Context

The pipeline CLI (`core/scripts/pipeline.ts`) currently has four modes dispatched from `main()`: advance (default), status, unblock, and cleanup. Labels are auto-created as a side effect of the first advance run (`ensurePipelineLabels` at pipeline.ts:126); they are skipped for `--status`, `--dry-run`, and `--unblock`. Config loading (`core/scripts/config.ts`) is read-only: it reads `.github/pipeline.yml` and falls back to `DEFAULT_CONFIG` when the file is absent — there is no write path. The `init` command must sit orthogonally to all existing modes and must not require an issue number.

## Goals / Non-Goals

**Goals:**
- Add `init` as a first-class CLI sub-command that runs before any issue-number check, mirrors `cleanup` in that respect.
- Reuse `ensurePipelineLabels` exactly as-is — no changes to its behavior.
- Add a `scaffoldDefaultConfig(repoDir)` write function to `config.ts` that produces a commented YAML template valid against the existing schema.
- No-clobber: if `.github/pipeline.yml` already exists, print a notice and skip scaffolding; still run label ensure.
- Document `init` in README as the recommended first step when onboarding a new repo.

**Non-Goals:**
- Writing secrets or API keys into the config template.
- Making `init` an install-time step (that's `scripts/install.mjs`).
- Interactive wizard / prompted config customisation.
- Changes to `ensurePipelineLabels` behavior for the normal advance path.

## Decisions

### 1. `init` is dispatched before the issue-number guard in `main()`

The existing `cleanup` mode is dispatched after config resolution but before the issue-number check. `init` follows the same pattern. This keeps issue-number parsing strictly inside the advance/status/unblock block and avoids touching that logic.

*Alternative considered*: a separate top-level `init.ts` entrypoint. Rejected — the existing CLI already owns option parsing; splitting it introduces a second binary and complicates installation.

### 2. `scaffoldDefaultConfig` lives in `config.ts`

`config.ts` already owns the schema, `DEFAULT_CONFIG`, and all path logic for `.github/pipeline.yml`. Putting the write function there keeps the config surface together and avoids a new module.

*Alternative*: a sibling `init.ts` file. Rejected — would duplicate path resolution logic and import DEFAULT_CONFIG from config.ts anyway.

### 3. Scaffold template is YAML with inline comments, not a separate `.example` file

The template must be immediately usable: the user edits it in place. Inline YAML comments explaining each key make it self-documenting without requiring a second reference file.

*Alternative*: copy `.github/pipeline.yml.example` committed to the repo. Rejected — introduces a second source of truth that can drift from `DEFAULT_CONFIG`.

### 4. Template is generated at call time from `DEFAULT_CONFIG`, not hardcoded

`scaffoldDefaultConfig` renders the YAML string programmatically from `DEFAULT_CONFIG` so that adding a new config key automatically appears in the scaffold. A hardcoded template string drifts.

*Alternative*: hardcoded template. Acceptable for simplicity but creates maintenance debt; programmatic generation is a small uplift.

### 5. Config scaffold validity is verified in tests by round-tripping through `resolveConfig`

The spec requires the scaffold to be valid against the config schema. Tests write the scaffold to a temp dir and call `resolveConfig` against it; if it throws, the test fails.

## Risks / Trade-offs

- **Template rendering complexity** → If `DEFAULT_CONFIG` ever gains nested structures with non-trivial types, the YAML serializer must handle them gracefully. Mitigation: use `js-yaml` (already a project dependency) to dump; add a snapshot test for the rendered output.
- **Label creation races** → If two `init` runs execute concurrently against the same repo, the second `gh label create` call may race with the first. Mitigation: `ensurePipelineLabels` already swallows `already exists` errors; no new risk introduced.
- **README section drift** → If new config keys are added after this change, the README onboarding section may become stale. Mitigation: the init command itself always reflects the current defaults; the README section is prose-level and does not enumerate every key.
