## Why

Existing `.github/pipeline.yml` files can remain valid while drifting away from the current `pipeline init` scaffold: new defaults, comments, and optional blocks are missing, and stale examples can contradict the current engine. Maintainers need a safe way to refresh config structure without changing effective behavior, and this repo's own config should stop carrying stale scaffold guidance.

## What Changes

- Add a `pipeline config sync` maintenance command that compares an existing `.github/pipeline.yml` to the current init scaffold.
- The command defaults to preview mode: it shows the proposed refreshed YAML or diff and performs no writes.
- Add an explicit apply mode that writes the refreshed config only when the generated file preserves the current effective behavior.
- Preserve active repo-specific overrides while adding newly supported default keys/comments from the current scaffold.
- Surface unknown, deprecated, or behavior-changing config differences as diagnostics instead of silently rewriting them.
- Update this repo's `.github/pipeline.yml` to match the current scaffold structure while preserving its intentional overrides.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `pipeline-configuration`: add a non-mutating/applyable config sync behavior that refreshes existing config structure while preserving effective settings.
- `config-validate-command`: extend the `pipeline config` command family with the `sync` subcommand's preview/apply contract.
- `init-command`: ensure sync reuses the current init scaffold as its structural baseline without changing init's no-clobber behavior.

## Impact

- Pipeline config command dispatch and help text.
- Config scaffold/sync helpers and tests.
- README and host skill documentation for the new command.
- This repo's `.github/pipeline.yml` active config and comments.
- Generated plugin mirror after core/host documentation changes.
