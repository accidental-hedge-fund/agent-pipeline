## Why

When a user sets `models.review`, `models.planning`, or `models.fix` in `.github/pipeline.yml` while the backing harness for that role is `codex`, the setting is silently ignored — `--model` is only passed on the `claude` branch of `harness.ts`. This creates a footgun: a developer believes they selected a model for a step, but nothing changes in practice.

## What Changes

- At config-resolve time (`resolveConfig` in `config.ts`), after merging file config with the profile, check each `models.*` key that was **explicitly set in the file** (`fileConfig.models?.<key>` present) against the active harness for that key's role.
- Emit a `console.warn` (non-blocking, one per inert key) when a `models.*` alias is set but the corresponding harness role is `codex` (which ignores the alias).
- No throw, no fallback, no change to resolved config values — strictly advisory.
- Default values (from `DEFAULT_CONFIG`) do **not** trigger the warning; only explicit user-authored config values do.

## Capabilities

### New Capabilities

- `config-inert-models-warn`: Detects and warns about `models.*` aliases that are explicitly set in `.github/pipeline.yml` but silently ignored because the backing harness role is `codex`.

### Modified Capabilities

- `pipeline-configuration`: Adds a new requirement for inert-alias detection to the config-resolution contract.

## Impact

- **`core/scripts/config.ts`** — add warning logic after fileConfig merge, within `resolveConfig`.
- **`core/test/config.test.ts`** (or adjacent) — new unit tests covering fire and no-fire cases via the config-resolve seam.
- No API surface changes; no schema changes; no behavior change to resolved config values.
- Plugin mirror (`plugin/`) must be regenerated after any `core/` changes.
