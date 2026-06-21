## ADDED Requirements

### Requirement: The advance-loop lifecycle SHALL be encapsulated in a PipelineRun service independent of the CLI parsing layer

`pipeline-run.ts` SHALL export a `runAdvance(cfg, issueNumber, opts, deps?)` function that encapsulates all advance-loop lifecycle concerns: acquiring the per-issue lock, setting up `GhMetricsCollector`, calling `ensurePipelineLabels`, creating the evidence bundle, initializing the run directory, starting the terminal log tee, running the stage loop (with audit-sentinel repair and auto-loop), appending lifecycle events, and finalizing the run. The function signature SHALL accept `cfg: PipelineConfig`, `issueNumber: number`, `opts: CliOpts`, and an optional `deps` injectable — identical to the current `runAdvance` in `pipeline.ts`. The CLI entry point (`pipeline.ts`) SHALL call this function with resolved values and SHALL NOT re-implement any lifecycle logic inline.

#### Scenario: CLI delegates advance-loop lifecycle to the PipelineRun service

- **WHEN** the user runs `pipeline 42` (the default advance command)
- **THEN** `pipeline.ts` SHALL resolve config and issue number, then call `runAdvance` from `pipeline-run.ts` with those resolved values
- **AND** `pipeline.ts` SHALL NOT directly call `withLock`, `GhMetricsCollector`, `createBundle`, `initRunDir`, `startTerminalLogTee`, `appendEvent`, or `finalizeRun`

#### Scenario: PipelineRun service does not import Commander

- **WHEN** `pipeline-run.ts` module imports are inspected
- **THEN** no import from `commander` SHALL appear in `pipeline-run.ts`
- **AND** no Commander types SHALL appear in the signature of `runAdvance`

### Requirement: The PipelineRun service SHALL be testable via injectable deps without invoking the CLI layer

`runAdvance` SHALL accept an optional `deps` parameter typed as `AdvanceDeps` (already defined in `pipeline.ts`). Unit tests SHALL call `runAdvance` directly — bypassing Commander — by injecting a fake clock and optionally other I/O seams. All existing behaviors observable through `AdvanceDeps` (e.g. wall-clock budgeting, auto-loop eligibility) SHALL remain testable at this boundary.

#### Scenario: Existing AdvanceDeps-based tests continue to pass after extraction

- **WHEN** the unit tests that previously tested `runAdvance` via injected `AdvanceDeps` are run against the extracted `pipeline-run.ts`
- **THEN** every test SHALL pass without modification to the test logic

#### Scenario: PipelineRun lifecycle can be exercised without Commander parsing

- **WHEN** a unit test calls `runAdvance(cfg, issueNumber, opts, { now: () => fakeMs })` directly
- **THEN** the function SHALL execute the advance-loop lifecycle (using the injected clock) without requiring `process.argv` or any Commander state

### Requirement: All existing advance-loop behaviors SHALL be preserved exactly after the extraction

The lifecycle behaviors currently implemented in `runAdvance` — kill-switch check (enforced by the caller in `pipeline.ts`), per-issue locking, GhMetrics collection, evidence bundle creation, run-directory initialization, terminal log tee, stage dispatch with audit-sentinel repair (both stage-level and blocked-label), auto-loop eligibility and budget, finalization, and tee teardown ordering — SHALL be preserved identically after the extraction. The extraction is a file move with no logic changes.

#### Scenario: Stage-loop iteration cap is preserved after extraction

- **WHEN** the pipeline advances through a sequence of stages without reaching a terminal or blocked state
- **THEN** the loop SHALL stop after at most `MAX_ITERATIONS` (12) transitions, identical to the current behavior

#### Scenario: Auto-loop budget check uses the injected clock

- **WHEN** `runAdvance` is called with `deps.now` returning a synthetic timestamp
- **THEN** `canAutoLoopContinue` SHALL use the injected value rather than `Date.now()`
- **AND** the wall-clock budget SHALL be evaluated against the injected timestamps

#### Scenario: Terminal log tee is stopped after the final 'done' line

- **WHEN** a run completes (any outcome)
- **THEN** the terminal log tee teardown SHALL occur AFTER the final run-completion log line is emitted
- **AND** that line SHALL be captured in `terminal.log`

### Requirement: The pipeline-run.ts module SHALL NOT import pipeline.ts

No import — direct or transitive — from `pipeline-run.ts` to `pipeline.ts` SHALL exist. This enforces the one-way dependency: the CLI layer imports the service layer; the service layer does not import the CLI layer.

#### Scenario: Import-direction unit test detects a cycle

- **WHEN** a unit test reads the import declarations of `pipeline-run.ts`
- **THEN** no import path resolving to `pipeline.ts` SHALL appear
- **AND** the test SHALL fail if such an import is added
