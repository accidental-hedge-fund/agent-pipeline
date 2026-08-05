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

When `pipeline run <N> --detach` is used, the launcher SHALL pin a
`.agent-pipeline/runs/<run-id>` run-store identity and pass it to the inner run (via
`--run-id`) so both share one run directory, and SHALL report that run-id/path to the caller.
The pinned run-store directory SHALL be rooted at the **resolved repository root** — the git
root of the resolved `--repo-path`, or of the current working directory — and SHALL NOT be
derived from an unvalidated start directory; when no repository root can be resolved, the
launcher SHALL refuse the launch rather than pin a run-store path (see the detached-launcher
capability). The detached run's `events.jsonl` and `terminal.log` — not the wrapper's
`pipeline.log`/`sentinel.json` — are the machine-readable Pipeline Desk contract.
`--json-events` SHALL be forwarded to the inner run when set.

#### Scenario: detached launch reports the run-store run directory

- **WHEN** `pipeline run <N> --detach` is invoked
- **THEN** the launcher SHALL pin a run-store run-id and forward it to the inner run
- **AND** the inner run SHALL use that same `.agent-pipeline/runs/<run-id>` directory
- **AND** the launcher SHALL report the run-store path so a desktop consumer can read
  `events.jsonl`/`terminal.log` without parsing the wrapper's `pipeline.log`

#### Scenario: detached run exposes the run store through a machine-readable pointer

- **WHEN** `pipeline run <N> --detach` is invoked
- **THEN** the launcher SHALL write a machine-readable `run-store.json` into the wrapper
  directory (which the caller captures from stdout) containing the run-store run id and the
  absolute `events.jsonl`/`terminal.log` paths
- **AND** a caller SHALL be able to discover `events.jsonl` from that pointer alone, without
  parsing any human-readable prose

#### Scenario: --json-events is forwarded to a detached run

- **WHEN** `pipeline run <N> --detach --json-events` is invoked
- **THEN** the inner detached run SHALL receive `--json-events`

#### Scenario: run store is pinned at the repository root, not the launch directory

- **WHEN** `pipeline run <N> --detach` is invoked from a subdirectory of a git checkout
- **THEN** the pinned run-store directory SHALL be `<git-root>/.agent-pipeline/runs/<run-id>`
- **AND** SHALL NOT be `<subdirectory>/.agent-pipeline/runs/<run-id>`

#### Scenario: an unresolvable repository yields no run-store path at all

- **WHEN** `pipeline run <N> --detach` is invoked where no git repository can be resolved from
  the start directory
- **THEN** the launcher SHALL NOT pin or report any `.agent-pipeline/runs/<run-id>` path
- **AND** SHALL NOT create a `run-store.json` pointer

### Requirement: run.json is written at run directory creation with immutable identity metadata
Immediately after creating the run directory, the orchestrator SHALL write `run.json` containing: `schema_version` (integer, initial value `1`), `run_id` (string), `issue` (integer), `repo` (string, `owner/name` format), `profile` (active profile name string, or `null` if not set), `started_at` (ISO 8601 UTC timestamp), and `engine` (object, or omitted when the engine identity cannot be resolved) carrying `version` (engine version string), `root` (resolved engine root path), and `templates_fingerprint` (fingerprint of the pinned prompt-template snapshot). The `engine` object pins the skill snapshot the run executes against, so a later engine change is detectable and attributable. `run.json` is written once and SHALL NOT be modified after creation.

#### Scenario: run.json written at init with all required fields
- **WHEN** `initRunDir(...)` is called with issue, repo, profile, and timestamp
- **THEN** `run.json` SHALL exist in the run directory
- **AND** SHALL contain `schema_version: 1`, `run_id`, `issue`, `repo`, `profile`, and `started_at`

#### Scenario: run.json records the pinned engine identity
- **WHEN** `initRunDir(...)` is called and the engine identity resolves
- **THEN** `run.json` SHALL contain an `engine` object with `version`, `root`, and `templates_fingerprint`

#### Scenario: An unresolvable engine identity omits the field rather than failing the run
- **WHEN** the engine version or template fingerprint cannot be resolved at run-directory creation
- **THEN** `run.json` SHALL be written with its other fields unchanged and the `engine` field omitted
- **AND** run-directory creation SHALL succeed

#### Scenario: run.json is not overwritten on subsequent dispatch cycles
- **WHEN** the orchestrator re-enters the dispatch loop for the same run-id
- **THEN** `run.json` SHALL remain unchanged from its initial write
- **AND** the `engine` object SHALL NOT be refreshed to the current on-disk engine

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

### Requirement: run.json engine identity SHALL record the engine track

When the orchestrator writes `run.json` with an `engine` identity object, that object SHALL
include a `track` field whose value is `"pinned"` or `"candidate"`, classifying whether the run
executes the production pin install or a candidate soak build. The existing `version`, `root`,
and `templates_fingerprint` fields remain required as specified by the baseline engine-identity
requirement. When the production pin version is known at run start, the engine object MAY also
include `pin_version` (string) equal to the pin target. When a git SHA for the executing engine
is resolvable without network, the engine object MAY include `git_sha`. Absence of optional
`pin_version` / `git_sha` SHALL NOT invalidate a run that still records `track`, `version`,
`root`, and `templates_fingerprint`. Historical run directories created before this field existed
SHALL remain readable; consumers SHALL treat a missing `track` as unknown rather than inventing
a track.

#### Scenario: Pinned-track run records track pinned

- **WHEN** a run directory is created for an execution classified as the production pin track
- **THEN** `run.json` `engine.track` SHALL equal `"pinned"`
- **AND** `engine.version` SHALL equal the running engine version

#### Scenario: Candidate-track run records track candidate

- **WHEN** a run directory is created for an FRG Layer B or other candidate soak execution
- **THEN** `run.json` `engine.track` SHALL equal `"candidate"`
- **AND** `engine.version` and `engine.root` SHALL identify the candidate engine

#### Scenario: Pre-track run.json remains readable

- **WHEN** a consumer reads a historical `run.json` whose `engine` object lacks `track`
- **THEN** the consumer SHALL treat track as unknown
- **AND** SHALL NOT throw solely because `track` is absent

#### Scenario: Track is captured once at run start

- **WHEN** the engine identity is written into `run.json` at run-directory creation
- **THEN** `track` SHALL reflect the classification at run start
- **AND** mid-run on-disk engine drift SHALL continue to use the existing `engine_drift` event
  path rather than rewriting `engine.track` in `run.json`

### Requirement: run.json engine identity SHALL record commit SHA when resolvable

The orchestrator SHALL include a `commit_sha` field on `run.json.engine` (git commit of the
engine root) when writing `run.json` at run-directory creation and that SHA is resolvable
from the engine installation. When the SHA cannot be resolved, `commit_sha` SHALL be
omitted or set to null without failing run-directory creation. Existing `version`, `root`,
and `templates_fingerprint` fields SHALL remain. `run.json` SHALL remain write-once (not
refreshed on later dispatch cycles).

#### Scenario: Resolvable engine SHA is recorded at init

- **WHEN** `initRunDir(...)` is called and the engine root yields git commit `deadbeef…`
- **THEN** `run.json.engine.commit_sha` SHALL equal that commit
- **AND** `engine.version`, `engine.root`, and `engine.templates_fingerprint` SHALL still
  be present when otherwise resolvable

#### Scenario: Unresolvable engine SHA does not fail run init

- **WHEN** engine version resolves but git SHA cannot be determined
- **THEN** `run.json` SHALL still be written successfully
- **AND** `engine.commit_sha` SHALL be absent or null
- **AND** other engine fields SHALL remain as today

#### Scenario: Engine identity is not rewritten mid-run

- **WHEN** the orchestrator re-enters the dispatch loop for the same run-id after the
  on-disk engine changes
- **THEN** `run.json.engine` including `commit_sha` SHALL remain the originally pinned
  values

---

### Requirement: run.json SHALL persist an explicit discovery-channel stamp for new runs

When writing `run.json` at run-directory creation, the orchestrator SHALL persist a
`discovery_channel` field using the closed discovery-channel vocabulary. Ordinary issue
advance and durable-loop item execution SHALL default this field to `live-run` when the
caller does not supply a more specific channel. The field is the run-level discovery-
attribution marker: scoreboard collectors SHALL inherit event-level discovery-channel
from it only when the field is present. Historical `run.json` files without
`discovery_channel` SHALL remain readable and SHALL NOT be treated as `live-run` merely
because `engine.version` (or other pre-#763 engine identity) is present.
`run.json` SHALL remain write-once (not refreshed on later dispatch cycles).

#### Scenario: New run stamps discovery_channel live-run by default

- **WHEN** `initRunDir(...)` is called for an ordinary advance without an explicit
  discovery channel override
- **THEN** `run.json.discovery_channel` SHALL equal `live-run`

#### Scenario: Explicit channel override is persisted

- **WHEN** `initRunDir(...)` is called with discovery channel `review-batch`
- **THEN** `run.json.discovery_channel` SHALL equal `review-batch`

#### Scenario: Historical run.json without discovery_channel is not invented as live-run

- **WHEN** a scoreboard collector reads a pre-#763 `run.json` that has `engine.version`
  but no `discovery_channel` field
- **THEN** the run-level discovery channel SHALL be treated as missing-attribution
- **AND** collectors SHALL NOT count that arrival as `live-run`

