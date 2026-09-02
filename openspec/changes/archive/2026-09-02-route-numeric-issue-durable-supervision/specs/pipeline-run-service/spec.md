## MODIFIED Requirements

### Requirement: The advance-loop lifecycle SHALL be exported from `pipeline-run.ts` independently of the CLI

The advance-loop orchestration (locking, run-directory initialization, stage dispatch, event emission, evidence bundle management, auto-loop budget tracking, finalization, and terminal-log tee) SHALL be encapsulated in `core/scripts/pipeline-run.ts` and exported as `runAdvance(cfg: PipelineConfig, issueNumber: number, opts: AdvanceOpts, deps?: AdvanceDeps): Promise<void>` (where `AdvanceOpts` is the thin advance options type owned outside the Commander CLI surface; an equivalent exported name is acceptable). That export SHALL remain the internal executor for nested whole-item advancement. Public mutating `pipeline <N>` SHALL NOT call this export as its top-level lifecycle owner. The CLI (`pipeline.ts`) MAY import the export for the non-public nested adapter and map any Commander-facing opts into `AdvanceOpts` at that internal call site. `pipeline-run.ts` SHALL NOT import types or values from `pipeline.ts`. The nested executor SHALL NOT recursively create another durable supervisor.

#### Scenario: CLI behavior is unchanged after extraction

- **WHEN** `pipeline <N>` is invoked after the extraction
- **THEN** public mutating numeric drive SHALL enter the one-item durable supervisor rather than using `runAdvance` as the top-level lifecycle owner
- **AND** nested whole-item advancement SHALL still use `runAdvance` as the internal executor
- **AND** a fixture that treats public numeric drive as a top-level `runAdvance` owner SHALL fail

#### Scenario: `runAdvance` is importable without importing the CLI

- **WHEN** a test imports `{ runAdvance, AdvanceDeps }` from `core/scripts/pipeline-run.ts`
- **THEN** the import SHALL succeed without importing Commander, triggering `process.argv` parsing, or invoking any CLI initialization side-effect
- **AND** `pipeline-run.ts` SHALL NOT contain a top-level import of `"commander"` or a `buildCmd()` call
- **AND** `pipeline-run.ts` SHALL NOT import from `./pipeline.ts` or `pipeline.ts`

#### Scenario: runAdvance accepts the thin advance options bag

- **WHEN** a caller invokes `runAdvance` with an `AdvanceOpts` object supplying only advance-relevant fields
- **THEN** the call SHALL type-check and run without requiring fat `CliOpts` fields for non-advance commands
- **AND** advance-loop `dispatch` SHALL likewise accept the thin bag rather than fat `CliOpts`
