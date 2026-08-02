# pipeline-run-service Specification

## Purpose
TBD - created by archiving change command-registry. Update Purpose after archive.
## Requirements
### Requirement: The advance-loop lifecycle SHALL be exported from `pipeline-run.ts` independently of the CLI

The advance-loop orchestration (locking, run-directory initialization, stage dispatch, event emission, evidence bundle management, auto-loop budget tracking, finalization, and terminal-log tee) SHALL be encapsulated in `core/scripts/pipeline-run.ts` and exported as `runAdvance(cfg: PipelineConfig, issueNumber: number, opts: AdvanceOpts, deps?: AdvanceDeps): Promise<void>` (where `AdvanceOpts` is the thin advance options type owned outside the Commander CLI surface; an equivalent exported name is acceptable). The CLI (`pipeline.ts`) SHALL call this export rather than embedding the lifecycle inline, mapping any Commander-facing opts into `AdvanceOpts` at the call site. The runtime behavior and observable outputs (stage transitions, GitHub label writes, events emitted, bundle contents) for a given logical option set SHALL be identical to the pre-split implementation. `pipeline-run.ts` SHALL NOT import types or values from `pipeline.ts`.

#### Scenario: CLI behavior is unchanged after extraction

- **WHEN** `pipeline <N>` is invoked after the extraction
- **THEN** the run outcome (stage transitions, labels applied, events emitted, bundle written, auto-loop behavior) SHALL be identical to the pre-extraction behavior for the same logical advance options
- **AND** no existing stage-loop test or lifecycle test SHALL require modification to pass beyond updating the options type name or import path

#### Scenario: `runAdvance` is importable without importing the CLI

- **WHEN** a test imports `{ runAdvance, AdvanceDeps }` from `core/scripts/pipeline-run.ts`
- **THEN** the import SHALL succeed without importing Commander, triggering `process.argv` parsing, or invoking any CLI initialization side-effect
- **AND** `pipeline-run.ts` SHALL NOT contain a top-level import of `"commander"` or a `buildCmd()` call
- **AND** `pipeline-run.ts` SHALL NOT import from `./pipeline.ts` or `pipeline.ts`

#### Scenario: runAdvance accepts the thin advance options bag

- **WHEN** a caller invokes `runAdvance` with an `AdvanceOpts` object supplying only advance-relevant fields
- **THEN** the call SHALL type-check and run without requiring fat `CliOpts` fields for non-advance commands
- **AND** advance-loop `dispatch` SHALL likewise accept the thin bag rather than fat `CliOpts`

### Requirement: The `pipeline-run.ts` module SHALL retain the injectable `AdvanceDeps` seam

The exported `runAdvance` function SHALL accept an optional `deps: AdvanceDeps` parameter with at minimum a `now?: () => number` clock injection point for the auto-loop wall-clock budget. The `AdvanceDeps` type SHALL be exported from `pipeline-run.ts`. Existing tests that import `AdvanceDeps` from `pipeline.ts` SHALL continue to pass; a re-export from `pipeline.ts` is acceptable to preserve existing import paths.

#### Scenario: Fake clock injection continues to work after extraction

- **WHEN** a test calls `runAdvance(fakeCfg, 42, fakeOpts, { now: () => fixedMs })`
- **THEN** the auto-loop wall-clock budget check uses `fixedMs` instead of `Date.now()`
- **AND** the test outcome matches the pre-extraction behavior with the same injected clock

#### Scenario: `AdvanceDeps` re-export from `pipeline.ts` is non-breaking

- **WHEN** existing code imports `{ AdvanceDeps }` from `pipeline.ts`
- **THEN** the import SHALL resolve to the same type as `{ AdvanceDeps }` from `pipeline-run.ts`
- **AND** no compile-time or runtime error occurs

