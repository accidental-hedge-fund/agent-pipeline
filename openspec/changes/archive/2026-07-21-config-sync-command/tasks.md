## 1. Config Sync Core

- [x] 1.1 Export the current config template helper so sync can share the init scaffold baseline.
- [x] 1.2 Add deterministic config sync helpers that load, validate, render, diff, and write `.github/pipeline.yml` through injectable filesystem deps.
- [x] 1.3 Preserve explicit scalar and nested overrides when rendering the synced config.
- [x] 1.4 Refuse to write when the current config is missing, invalid, or the rendered candidate fails validation.

## 2. CLI Command

- [x] 2.1 Add `pipeline config sync [--apply] [--json] [--repo-path <path>]` dispatch and help text.
- [x] 2.2 Make preview mode non-mutating and print a reviewable diff or no-op message.
- [x] 2.3 Make apply mode write only after safe validation and print a clear success/no-op result.

## 3. Repository Config Drift

- [x] 3.1 Refresh this repo's `.github/pipeline.yml` default-reference structure to match the current scaffold shape.
- [x] 3.2 Preserve this repo's active overrides: domain context, OpenSpec auto mode, model aliases, CI command, plan-review timeout, and review policy.

## 4. Tests and Docs

- [x] 4.1 Add unit tests for preview, apply, invalid config refusal, missing config refusal, and nested override preservation.
- [x] 4.2 Add CLI-level tests for `pipeline config sync`.
- [x] 4.3 Document `config sync` in the README and host skill docs.
- [x] 4.4 Regenerate the plugin mirror.
- [x] 4.5 Run OpenSpec validation, targeted tests, and full CI.
