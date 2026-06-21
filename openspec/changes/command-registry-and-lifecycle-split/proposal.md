## Why

`pipeline.ts` (2,458 lines) entangles five distinct responsibilities: Commander wiring, per-command flag-validation guards, config-resolution branching, mutating dispatch, and the advance-loop lifecycle (locking, metrics, evidence bundle, stage loop, audit-sentinel repair, auto-loop, run directory, finalization). Every new subcommand touches the same monolithic file in incompatible ways — the merge-command flag-allowlist fix (#217) and the 700-line `main()` with scattered per-command guard blocks are direct symptoms. The structure makes it impossible to enumerate valid flags for a command without reading every guard, and the advance-loop lifecycle cannot be unit-tested without reaching through the CLI layer.

## What Changes

- **Command registry** (`command-registry.ts`): a typed declaration table mapping every subcommand name to its metadata — `allowedFlags` (allowlist of `CliOpts` keys), `mutatesGitHub`, `needsConfig`, `needsIssue`, `supportsJson`, and `requiresArgs`. The CLI entry point uses the registry to validate flags generically; no command needs its own hand-written guard block for categorically inapplicable flags.
- **`PipelineRun` service** (`pipeline-run.ts`): an encapsulation of the advance-loop lifecycle currently inlined in `runAdvance` — `withLock`, `GhMetricsCollector` setup, `ensurePipelineLabels`, evidence bundle creation, run-directory init, terminal log tee, stage-loop with audit-sentinel repair, auto-loop budget, event writes, and finalization. The CLI calls it with resolved values; no Commander types cross the boundary.
- **`pipeline.ts` (CLI layer)**: slims to Commander setup + registry lookup + flag validation + dispatch. `main()` no longer embeds the stage loop or locking logic.
- No change to stage handlers, `gh.ts`, `config.ts`, `types.ts`, evidence bundle, or any state-machine behavior.

## Capabilities

### New Capabilities
- `command-registry`: A declarative table of every CLI subcommand with per-command metadata: `allowedFlags` allowlist, `mutatesGitHub`, `needsConfig`, `needsIssue`, `supportsJson`, and `requiresArgs`. The CLI entry point SHALL use this table to reject unrecognized or disallowed flags for every command — no command needs a bespoke hand-written guard block for flags that are categorically inapplicable.
- `pipeline-run-lifecycle-service`: A `PipelineRun` service that encapsulates the advance-loop lifecycle — locking, GhMetrics setup, `ensurePipelineLabels`, evidence bundle, stage-loop, audit-sentinel repair, auto-loop, run directory, terminal tee, event writes, and finalization — independently of the CLI parsing layer, with injectable deps for unit testing.

### Modified Capabilities

*(none — no existing spec-level requirements change)*

## Impact

- `core/scripts/pipeline.ts` (shrinks materially), new `core/scripts/command-registry.ts`, new `core/scripts/pipeline-run.ts`
- `core/test/`: golden CLI parsing tests (new); existing stage-loop unit tests continue passing; new `PipelineRun` tests exercise the lifecycle via injectable deps
- `plugin/` mirror must be regenerated after all changes (`node scripts/build.mjs`)
- No changes to `.github/pipeline.yml` schema, `gh.ts`, `config.ts`, `types.ts`, stage handlers, or any externally-visible behavior
