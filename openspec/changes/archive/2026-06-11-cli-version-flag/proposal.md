## Why

The pipeline CLI has no `--version` flag, making it impossible to confirm which installed version is running without inspecting `package.json` directly. Now that the package version is meaningful (v1.0.1, tagged), a quick `pipeline --version` is the expected support and debugging primitive.

## What Changes

- Add `--version` / `-V` flag to the commander-based CLI (`core/scripts/pipeline.ts`) that prints the current package version and exits 0, without requiring an issue number or touching GitHub.
- Version is read from `core/package.json` at runtime (single source of truth); no hardcoding.
- Unit test asserts the resolved version string matches `core/package.json`'s `version` field.
- Regenerate `plugin/` mirror after the `core/` change.

## Capabilities

### New Capabilities

- `cli-version-flag`: CLI exposes `--version` / `-V` that prints the package version (sourced from `package.json`) and exits 0.

### Modified Capabilities

<!-- None: no existing spec-level behavior changes. -->

## Impact

- **Files changed**: `core/scripts/pipeline.ts` (add `.version()` call), `core/test/` (new regression test), `plugin/` (regenerated mirror).
- **Dependencies**: No new runtime dependencies; commander's built-in `.version()` handles the flag.
- **APIs / external systems**: None — flag is fully local.
- **Breaking changes**: None.
