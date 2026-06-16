## Why

The pipeline currently invokes the claude implementer harness with `--permission-mode bypassPermissions`, which grants the subprocess unrestricted host access — a risk when running autonomous code execution in shared or sensitive environments. Repos that need tighter containment have no opt-in mechanism today.

## What Changes

- Adds a single opt-in config key `harness_sandbox: true` to `.github/pipeline.yml`.
- When `harness_sandbox` is `true`, the claude harness invocation swaps `--permission-mode bypassPermissions` → `--permission-mode default` (claude's native sandboxed permission mode).
- The codex harness is already workspace-write-sandboxed via `--full-auto`; its invocation is unchanged in both modes.
- Default behaviour (`harness_sandbox` absent or `false`) is byte-identical to the current invocation — no flag changes, no regressions.

## Capabilities

### New Capabilities

- `harness-sandbox-mode`: Opt-in config flag that switches the claude implementer to its native sandboxed permission mode instead of `bypassPermissions`.

### Modified Capabilities

- `pipeline-configuration`: The `PartialConfigSchema` gains one new optional boolean key `harness_sandbox`; `DEFAULT_CONFIG` sets it to `false`.

## Impact

- **`core/scripts/config.ts`** — add `harness_sandbox: z.boolean().optional()` to `PartialConfigSchema`; add `harness_sandbox: false` to `DEFAULT_CONFIG` and `PipelineConfig` type.
- **`core/scripts/harness.ts`** — `invoke()` (claude branch) reads the resolved config and emits `--permission-mode default` when `harness_sandbox` is `true`; otherwise emits `--permission-mode bypassPermissions` as today.
- **`core/scripts/types.ts`** — add `harness_sandbox: boolean` field.
- **`core/test/`** — new unit tests for the flag; regression test that the default path is byte-identical.
- **`plugin/`** — regenerated mirror (no hand-edits).

## Acceptance Criteria

- [ ] `.github/pipeline.yml` can set `harness_sandbox: true` without a validation error.
- [ ] When `harness_sandbox: true`, the claude harness is invoked with `--permission-mode default` (not `bypassPermissions`).
- [ ] When `harness_sandbox` is absent or `false`, the claude harness invocation is byte-identical to the current behaviour (`--permission-mode bypassPermissions`).
- [ ] The codex harness invocation is identical in both modes.
- [ ] Unit tests cover the sandboxed and default branches; at least one test proves the default path is unchanged.
- [ ] `npm run ci` passes (core tests + mirror sync + install smoke).
