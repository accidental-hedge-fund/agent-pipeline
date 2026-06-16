# run-directory-layout Specification

## Purpose
TBD - created by archiving change desktop-run-artifact-contract. Update Purpose after archive.
## Requirements
### Requirement: Pipeline creates a stable, crash-safe run directory before the first stage
The pipeline orchestrator SHALL create a run directory at `.agent-pipeline/runs/<run-id>/` before any stage handler is called for a dispatch cycle. The `<run-id>` SHALL be a deterministic, filesystem-safe string formed from the issue number and the UTC dispatch start timestamp including milliseconds (e.g. `<issue>-<YYYY-MM-DDTHH-MM-SS-mmmZ>`). Millisecond precision is required so that two dispatches for the same issue starting in the same second produce distinct run directories. The run-id SHALL remain constant across all stages within a single dispatch cycle.

#### Scenario: run directory created before first stage
- **WHEN** the pipeline orchestrator begins dispatching for issue N
- **THEN** a directory SHALL exist at `.agent-pipeline/runs/<run-id>/` before any stage handler is called
- **AND** `<run-id>` SHALL encode the issue number and a UTC timestamp

#### Scenario: run-id is stable within a dispatch cycle
- **WHEN** the orchestrator advances from stage A to stage B within the same dispatch cycle
- **THEN** both stages SHALL observe the same `<run-id>` and the same run directory path

#### Scenario: run directory survives an unexpected process exit
- **WHEN** the pipeline process exits unexpectedly mid-run (SIGKILL, crash)
- **THEN** the run directory SHALL remain on disk and be readable
- **AND** `run.json` and `events.jsonl` SHALL be present and parseable for all complete events up to the crash

---

### Requirement: A detached launch exposes the same run-store run directory
When `pipeline run <N> --detach` is used, the launcher SHALL pin a `.agent-pipeline/runs/<run-id>` run-store identity and pass it to the inner run (via `--run-id`) so both share one run directory, and SHALL report that run-id/path to the caller. The detached run's `events.jsonl` and `terminal.log` — not the wrapper's `pipeline.log`/`sentinel.json` — are the machine-readable Pipeline Desk contract. `--json-events` SHALL be forwarded to the inner run when set.

#### Scenario: detached launch reports the run-store run directory
- **WHEN** `pipeline run <N> --detach` is invoked
- **THEN** the launcher SHALL pin a run-store run-id and forward it to the inner run
- **AND** the inner run SHALL use that same `.agent-pipeline/runs/<run-id>` directory
- **AND** the launcher SHALL report the run-store path so a desktop consumer can read `events.jsonl`/`terminal.log` without parsing the wrapper's `pipeline.log`

#### Scenario: --json-events is forwarded to a detached run
- **WHEN** `pipeline run <N> --detach --json-events` is invoked
- **THEN** the inner detached run SHALL receive `--json-events`

---

### Requirement: run.json is written at run directory creation with immutable identity metadata
Immediately after creating the run directory, the orchestrator SHALL write `run.json` containing: `schema_version` (integer, initial value `1`), `run_id` (string), `issue` (integer), `repo` (string, `owner/name` format), `profile` (active profile name string, or `null` if not set), and `started_at` (ISO 8601 UTC timestamp). `run.json` is written once and SHALL NOT be modified after creation.

#### Scenario: run.json written at init with all required fields
- **WHEN** `initRunDir(...)` is called with issue, repo, profile, and timestamp
- **THEN** `run.json` SHALL exist in the run directory
- **AND** SHALL contain `schema_version: 1`, `run_id`, `issue`, `repo`, `profile`, and `started_at`

#### Scenario: run.json is not overwritten on subsequent dispatch cycles
- **WHEN** the orchestrator re-enters the dispatch loop for the same run-id
- **THEN** `run.json` SHALL remain unchanged from its initial write

---

### Requirement: terminal.log captures raw combined output in all pipeline modes
The orchestrator SHALL write a `terminal.log` file in the run directory capturing the raw combined stdout/stderr of the pipeline run as it is produced. `terminal.log` SHALL be written regardless of whether `--json-events` is enabled. This file enables PTY-tailing and the `logs --follow` command to coexist with JSON event streaming.

#### Scenario: terminal.log written in standard mode
- **WHEN** the pipeline runs without `--json-events`
- **THEN** `terminal.log` SHALL be present in the run directory and contain the combined pipeline output

#### Scenario: terminal.log written in json-events mode
- **WHEN** the pipeline runs with `--json-events`
- **THEN** `terminal.log` SHALL still be written with the full human-readable output
- **AND** the JSON event stream on stdout SHALL not replace or suppress `terminal.log` content

#### Scenario: terminal.log contains output up to the point of a crash
- **WHEN** the pipeline process exits unexpectedly mid-run
- **THEN** `terminal.log` SHALL contain all output produced before the exit

---

### Requirement: summary.json holds the finalized evidence bundle; legacy path preserved
At finalization, the orchestrator SHALL write `summary.json` to the run directory. The content SHALL be the finalized evidence bundle (equivalent to #147's `formatSummary` output), including `schema_version`, `run_id`, `finalState`, `finalizedAt`, and all stage, review, override, and recovery records. After writing `summary.json`, the orchestrator SHALL also write the same content to `<stateDir>/<issueNumber>/evidence.json` to preserve backward compatibility with consumers that use the legacy path.

#### Scenario: summary.json written at finalization
- **WHEN** `finalizeRun(...)` is called
- **THEN** `summary.json` SHALL exist in the run directory
- **AND** SHALL contain `schema_version`, `run_id`, `finalState`, `finalizedAt`, and all accumulated stage records

#### Scenario: legacy evidence.json path readable after finalization
- **WHEN** finalization completes
- **THEN** `<stateDir>/<issueNumber>/evidence.json` SHALL be readable and contain the same content as `summary.json`

#### Scenario: summary.json absent for a crashed run
- **WHEN** the pipeline process exits before `finalizeRun()` is called
- **THEN** `summary.json` SHALL be absent from the run directory
- **AND** consumers SHALL treat a missing `summary.json` as an in-progress or crashed run (not an error)

---

### Requirement: Run directory contains only well-known files; local-only fields use _ prefix
The run directory files (`run.json`, `events.jsonl`, `terminal.log`, `summary.json`) SHALL be the only files the orchestrator writes to the run directory. Any field whose value is local-machine-specific (e.g. the absolute run directory path) SHALL use a leading-underscore name (e.g. `_localRunDir`) following the `run-artifact-conventions` convention.

#### Scenario: local-path field is prefixed with _
- **WHEN** a run artifact record includes the absolute filesystem path of the run directory
- **THEN** that field's name SHALL start with `_` (e.g. `_localRunDir`)

#### Scenario: non-local fields do not use _ prefix
- **WHEN** a field in a run artifact is safe to share across machines (e.g. `run_id`, `issue`, `schema_version`)
- **THEN** its name SHALL NOT start with `_`

