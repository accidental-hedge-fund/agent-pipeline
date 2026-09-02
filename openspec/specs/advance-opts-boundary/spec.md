# advance-opts-boundary Specification

## Purpose
TBD - created by archiving change split-advance-opts-from-cliopts. Update Purpose after archive.

## Requirements

### Requirement: AdvanceOpts SHALL be owned outside the Commander CLI surface

The advance-loop options bag SHALL be a dedicated type (named `AdvanceOpts` or an equivalent exported type) defined outside `core/scripts/pipeline.ts` and outside Commander program construction. The type SHALL include only fields consumed by the advance loop and stage dispatch (the implementer SHALL derive the field set from `opts.*` reads in the run module; unused kitchen-sink CLI fields such as scoreboard, queue, loop, correction, or report attributes SHALL NOT appear on the bag). Fat `CliOpts` MAY remain the Commander-facing parse shape for the CLI module.

#### Scenario: AdvanceOpts is importable without importing the CLI

- **WHEN** a test or module imports the advance options type from its owning module
- **THEN** the import SHALL succeed without importing `commander`, constructing `buildCmd()`, or loading CLI main-path initialization side effects
- **AND** the owning module SHALL NOT be `pipeline.ts`

#### Scenario: AdvanceOpts excludes non-advance CLI kitchen-sink fields

- **WHEN** the advance options type definition is inspected
- **THEN** it SHALL NOT declare fields used only by non-advance commands (for example scoreboard cost estimates, loop resume selectors, correction-record attributes, or merge-queue release flags)
- **AND** it SHALL declare the fields the advance loop actually reads (including at least dry-run, model, once, override, json-events, profile, and run-id when those remain run-side consumers)

---

### Requirement: The advance run module SHALL NOT import the CLI module

`core/scripts/pipeline-run.ts` SHALL NOT import types or values from `./pipeline.ts` / `pipeline.ts`. The advance run module MAY import shared neutral modules, stage modules, and other non-CLI engine modules. The CLI module MAY import the advance run module and map fat CLI opts into the advance options bag at the internal executor call site. Public mutating `pipeline <N>` SHALL NOT call that executor as its top-level lifecycle owner. Nested whole-item advancement SHALL pass the mapped bag through the non-public adapter.

#### Scenario: Source-level cycle break

- **WHEN** `pipeline-run.ts` is inspected for imports
- **THEN** it SHALL contain no import (type-only or value) whose specifier resolves to `pipeline.ts`
- **AND** a unit/regression test SHALL fail if such an import is reintroduced

#### Scenario: CLI still drives advance via runAdvance

- **WHEN** the operator invokes mutating numeric advance (`pipeline <N>` / equivalent public entry)
- **THEN** the CLI SHALL enter the one-item durable supervisor rather than calling `runAdvance` as the top-level lifecycle owner
- **AND** nested whole-item advancement SHALL still call `runAdvance` with a mapped advance options bag
- **AND** stage transitions, labels, events, bundles, and auto-loop behavior for that nested child SHALL match the existing executor contract for the same logical option values

### Requirement: Review-ceiling marker and related helpers SHALL be single-sourced

The string marker used to identify review-ceiling comments (`REVIEW_CEILING_MARKER`, currently `"## Pipeline: Review ceiling reached"`), the pure `ceilingRound` parser, and the `evidenceTimestamp` helper SHALL each have exactly one definition shared by CLI and advance-run consumers. Duplicate “kept in sync manually” local copies in `pipeline.ts` and `pipeline-run.ts` SHALL be removed. Existing import paths that obtain `ceilingRound` from `pipeline.ts` MAY continue to work via re-export.

#### Scenario: One marker constant for CLI and run

- **WHEN** both the CLI ceiling/override paths and the advance-run ceiling resume path need the review-ceiling comment prefix
- **THEN** both SHALL reference the same exported constant value
- **AND** neither module SHALL maintain a private duplicate string of that marker

#### Scenario: ceilingRound behavior remains pure and shared

- **WHEN** `ceilingRound` is called with a ceiling comment body containing a controlled `Review N re-ran` line for N in `{1,2}`
- **THEN** it SHALL return that N
- **AND** when the controlled line is absent it SHALL return `null`
- **AND** CLI and run paths SHALL invoke the same function implementation (not separately maintained copies)

#### Scenario: evidenceTimestamp format remains seconds-precision ISO

- **WHEN** either CLI or run records an evidence/event timestamp via the shared helper
- **THEN** the value SHALL be an ISO-8601 UTC string at seconds precision (fractional seconds stripped, `Z` suffix), matching the pre-split format

---

### Requirement: Residual dead stage imports in the CLI module SHALL be removed

After the advance loop extraction, `pipeline.ts` SHALL NOT retain stage-module imports that have zero remaining references in that file. Imports still required by CLI-side handlers (for example review-stage helpers used by override/ceiling flows) SHALL be retained. This requirement does not authorize unrelated refactors of stage modules.

#### Scenario: Unused stage namespace imports deleted

- **WHEN** a stage import in `pipeline.ts` has no remaining identifier uses in that file
- **THEN** the import SHALL be removed as part of this change

#### Scenario: Still-used stage imports retained

- **WHEN** a CLI path still calls a stage helper (for example ceiling finding tagging)
- **THEN** the corresponding stage import SHALL remain and behavior of that CLI path SHALL be unchanged
