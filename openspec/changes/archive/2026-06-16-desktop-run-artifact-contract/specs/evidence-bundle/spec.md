## MODIFIED Requirements

### Requirement: Pipeline run writes a JSON evidence bundle to a stable, issue-scoped path
The pipeline orchestrator SHALL create a run directory at `.agent-pipeline/runs/<run-id>/` before any stage handler is called (see `run-directory-layout` spec). The evidence bundle is now composed of two files within that directory: `events.jsonl` (incremental append-only event log, see `events-jsonl-streaming` spec) and `summary.json` (the finalized bundle written at `finalizeRun()`). For backward compatibility, `summary.json` content SHALL also be written to `<stateDir>/<issueNumber>/evidence.json` at finalization. The legacy `evidence.json` at `<stateDir>/<issueNumber>/evidence.json` SHALL remain readable after finalization so that existing consumers experience no breakage.

#### Scenario: run directory and event log created at dispatch entry
- **WHEN** the pipeline orchestrator begins dispatching for issue N
- **THEN** the run directory SHALL exist at `.agent-pipeline/runs/<run-id>/` before any stage handler is called
- **AND** `events.jsonl` SHALL be present in that directory (empty or containing a `run_start` event)
- **AND** the run directory SHALL contain `run.json` with `schema_version: 1` and `run_id`

#### Scenario: bundle directory created if absent
- **WHEN** `.agent-pipeline/runs/` does not exist at dispatch entry
- **THEN** the orchestrator SHALL create the full directory path before writing any files

#### Scenario: summary.json written at finalization with full bundle content
- **WHEN** `finalizeRun(...)` is called
- **THEN** `summary.json` SHALL be written to the run directory
- **AND** SHALL contain `schema_version`, `run_id`, `finalState`, `finalizedAt`, and all accumulated stage, review, override, and recovery records

#### Scenario: legacy evidence.json remains readable after finalization
- **WHEN** finalization writes `summary.json`
- **THEN** `<stateDir>/<issueNumber>/evidence.json` SHALL also be written with the same content
- **AND** existing consumers that read the legacy path SHALL receive the finalized bundle without modification

---

### Requirement: Bundle records stage transitions incrementally
For each pipeline stage, the orchestrator SHALL append a `stage_start` event to `events.jsonl` when the stage handler is entered and a `stage_complete` event when the stage handler exits. The `stage_complete` event SHALL contain: `stage` (stage name string), `at` (ISO 8601 timestamp), `outcome` (one of `"advanced"`, `"blocked"`, `"skipped"`, or `"error"`), and `commits` (array of commit SHA strings produced during the stage). `commands` (array of `CommandRecord`) and `prompts` (array of `PromptRecord`) are accumulated per-stage during execution and appear only in `summary.json` at finalization — they are not included in individual `stage_complete` events because they are collected deep inside stage handlers and are not available at the orchestrator level where events are appended. The full accumulated stage history (including commands and prompts) SHALL appear in `summary.json` at finalization.

#### Scenario: stage entry recorded as stage_start event
- **WHEN** a stage handler is entered
- **THEN** a `stage_start` event SHALL be appended to `events.jsonl` with `stage` and `at`

#### Scenario: stage exit recorded as stage_complete event
- **WHEN** a stage handler exits
- **THEN** a `stage_complete` event SHALL be appended to `events.jsonl` with `stage`, `at`, `outcome`, and `commits`

#### Scenario: multiple stages recorded in order in events.jsonl
- **WHEN** stages `planning` → `review` → `pre-merge` each complete
- **THEN** `events.jsonl` SHALL contain `stage_start`/`stage_complete` pairs for all three in the order they executed
