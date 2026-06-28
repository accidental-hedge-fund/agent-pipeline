# pipeline-run-service Specification

## Purpose
TBD - created by archiving change command-registry. Update Purpose after archive.
## Requirements
### Requirement: The advance-loop lifecycle SHALL be exported from `pipeline-run.ts` independently of the CLI

The advance-loop orchestration (locking, run-directory initialization, stage dispatch, event emission, evidence bundle management, auto-loop budget tracking, finalization, and terminal-log tee) SHALL be encapsulated in `core/scripts/pipeline-run.ts` and exported as `runAdvance(cfg: PipelineConfig, issueNumber: number, opts: CliOpts, deps?: AdvanceDeps): Promise<void>`. The CLI (`pipeline.ts`) SHALL call this export rather than embedding the lifecycle inline. The signature, runtime behavior, and observable outputs (stage transitions, GitHub label writes, events emitted, bundle contents) SHALL be identical to the pre-extraction implementation.

#### Scenario: CLI behavior is unchanged after extraction

- **WHEN** `pipeline <N>` is invoked after the extraction
- **THEN** the run outcome (stage transitions, labels applied, events emitted, bundle written, auto-loop behavior) SHALL be identical to the pre-extraction behavior
- **AND** no existing stage-loop test or lifecycle test SHALL require modification to pass

#### Scenario: `runAdvance` is importable without importing the CLI

- **WHEN** a test imports `{ runAdvance, AdvanceDeps }` from `core/scripts/pipeline-run.ts`
- **THEN** the import SHALL succeed without importing Commander, triggering `process.argv` parsing, or invoking any CLI initialization side-effect
- **AND** `pipeline-run.ts` SHALL NOT contain a top-level import of `"commander"` or a `buildCmd()` call

---

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

