# evidence-bundle Specification

## Purpose
TBD - created by archiving change evidence-bundle. Update Purpose after archive.
## Requirements
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

### Requirement: Bundle records run identity fields
The evidence bundle SHALL contain the following identity fields, set at creation time: `runId` (the pipeline run identifier), `issue` (the GitHub issue number), `pr` (the pull request number, or `null` if no PR exists), `branch` (the current worktree branch name), and `harnesses` (an array of harness identity strings used in this run).

#### Scenario: identity fields present after creation
- **WHEN** `createBundle()` is called with `runId`, `issue`, `pr`, `branch`, and `harnesses`
- **THEN** the resulting JSON object SHALL have `runId`, `issue`, `pr`, `branch`, and `harnesses` set to the supplied values
- **AND** `finalState` SHALL be `null`
- **AND** `finalizedAt` SHALL be `null`

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

### Requirement: Bundle records compact prompt/context metadata per harness invocation
Each harness prompt sent during a review or fix stage SHALL be recorded as a `PromptRecord` appended to that stage's `prompts` array. A `PromptRecord` SHALL contain: `kind` (short label for what the prompt does, e.g. `"review-standard"`), `harness` (the harness name), `hash` (8-character hex prefix of SHA-1 of the redacted prompt content), and `excerpt` (first 500 characters of the redacted prompt). The same secret-redaction rules that apply to `CommandRecord` SHALL apply to `PromptRecord`. Every `StageRecord` SHALL initialize with an empty `prompts` array.

#### Scenario: review prompt recorded
- **WHEN** `invokePromptHarnessReview()` is called with `opts.stateDir` set
- **THEN** a `PromptRecord` SHALL be appended to the `review-N` stage entry before `invoke()` is called
- **AND** `kind` SHALL be `"review-standard"` for round 1 and `"review-adversarial"` for round 2

#### Scenario: fix prompt recorded
- **WHEN** `advanceFix()` calls `buildFixPrompt()` and `opts.stateDir` is set
- **THEN** a `PromptRecord` SHALL be appended to the `fix-N` stage entry before `invoke()` is called

#### Scenario: prompt excerpt capped at 500 characters
- **WHEN** a prompt exceeds 500 characters
- **THEN** `excerpt` SHALL contain only the first 500 characters of the redacted prompt

#### Scenario: no raw secret values in prompt record
- **WHEN** a prompt contains a GitHub token or env var value matching the secret pattern
- **THEN** those values SHALL be replaced with `[REDACTED]` in both `hash` input and `excerpt`

---

### Requirement: Bundle records commands with outcome and duration; raw env values are excluded
Each shell command executed by a stage SHALL be recorded as a `CommandRecord` with: `cmd` (the command string), `exitCode` (integer), `durationMs` (integer), and `outputExcerpt` (first 500 characters of combined stdout/stderr). Raw environment variable values, tokens, or secrets SHALL NOT appear anywhere in the bundle.

#### Scenario: command recorded with exit code and duration
- **WHEN** a stage executes a shell command and calls `recordCommand()` with `cmd`, `exitCode`, `durationMs`, and output
- **THEN** the corresponding stage entry `commands` array SHALL contain a `CommandRecord` with those fields

#### Scenario: output truncated to 500 characters
- **WHEN** the combined stdout/stderr of a command exceeds 500 characters
- **THEN** `outputExcerpt` SHALL contain only the first 500 characters

#### Scenario: no raw env values in bundle
- **WHEN** the bundle is written
- **THEN** no field in `CommandRecord` or any other bundle field SHALL contain a value derived from a raw environment variable, authentication token, or secret

---

### Requirement: Bundle records review verdict summaries
After each review round, the bundle SHALL record a `ReviewRecord` containing: `round` (integer, 1-indexed), `sha` (the head commit SHA reviewed), `verdict` (the verdict string from the review schema, e.g. `"approved"` or `"changes_requested"`), and `findingCounts` (an object mapping severity levels to integer counts).

The `ReviewRecord` SHALL additionally carry a `findings` array — one structured record per finding enumerated by the round — and the reviewer identity for the round (`harness`, the harness that actually reviewed; `model`, the reviewer model; and `selfReview`, a boolean). Each finding record SHALL contain `key` (the stable `findingKey` from `review-policy.ts`), `severity`, `title`, `body`, `confidence`, and `recommendation`, and SHALL contain `file`, `line_start`, `line_end`, `category`, and `blocking` when the finding carries them. Each finding record SHALL also carry `effective_blocking` (boolean, computed from `partitionFindings` after the active review policy is applied — `true` when the finding blocks pipeline advancement, `false` when advisory or overridden) and `payload_fingerprint` (`findingPayloadFingerprint(finding)` — disambiguates distinct findings that share the same `findingKey` within a round). These additions are optional fields, so the bundle `schema_version` SHALL remain `1`; finding text fields SHALL be screened by the write-time injection denylist and secret redaction before the bundle is serialized.

#### Scenario: review verdict recorded
- **WHEN** the review stage parses a verdict JSON and calls `recordReview()`
- **THEN** the bundle `reviews` array SHALL contain a `ReviewRecord` with `round`, `sha`, `verdict`, and `findingCounts`

#### Scenario: review record carries per-finding records
- **WHEN** a review round enumerates one or more findings and `recordReview()` is called
- **THEN** the `ReviewRecord` SHALL contain a `findings` array with one record per finding
- **AND** each record SHALL contain `key`, `severity`, `title`, `body`, `confidence`, and `recommendation`
- **AND** the `key` SHALL equal `findingKey(finding)` so it correlates with `overrides[]` and with the same finding in another round

#### Scenario: review record carries reviewer identity
- **WHEN** a review round completes and `recordReview()` is called
- **THEN** the `ReviewRecord` SHALL contain `harness` (the harness that actually reviewed), `model`, and `selfReview`

#### Scenario: review record with zero findings carries an empty array
- **WHEN** a review round produces a verdict with no enumerated findings
- **THEN** the `ReviewRecord` `findings` array SHALL be empty
- **AND** `verdict` and `findingCounts` SHALL still be recorded

#### Scenario: multiple review rounds accumulate
- **WHEN** two review rounds complete
- **THEN** the bundle `reviews` array SHALL contain two entries with `round: 1` and `round: 2` respectively
- **AND** a consumer SHALL be able to derive per-finding resolution by comparing the `key` sets of the two rounds' `findings` arrays

### Requirement: Bundle records override dispositions
Each `--override` applied during the run SHALL be recorded in the bundle as an `OverrideRecord` containing the override `key` and the human-provided `reason`.

#### Scenario: override recorded
- **WHEN** an override is applied and `recordOverride()` is called with `key` and `reason`
- **THEN** the bundle `overrides` array SHALL contain an `OverrideRecord` with those values

---

### Requirement: Bundle records recovery events
Each auto-recovery trigger SHALL be recorded in the bundle as a `RecoveryRecord` containing: `trigger` (the recovery trigger label string), `round` (integer), and `at` (ISO 8601 timestamp).

#### Scenario: recovery event recorded
- **WHEN** `auto_recover` fires and calls `recordRecovery()` with `trigger`, `round`, and timestamp
- **THEN** the bundle `recoveries` array SHALL contain a `RecoveryRecord` with those values

---

### Requirement: Bundle records the terminal pipeline state at finalization
When the pipeline run ends (either reaching `ready-to-deploy` or being abandoned), `finalizeBundle()` SHALL be called. It SHALL set `finalState` to the terminal state string and `finalizedAt` to the current ISO 8601 timestamp.

#### Scenario: bundle finalized with ready-to-deploy
- **WHEN** the pipeline transitions to `ready-to-deploy` and `finalizeBundle("ready-to-deploy")` is called
- **THEN** the bundle `finalState` SHALL be `"ready-to-deploy"`
- **AND** `finalizedAt` SHALL be a valid ISO 8601 timestamp

#### Scenario: partial run has null finalState
- **WHEN** a pipeline run is interrupted before `finalizeBundle()` is called
- **THEN** the bundle `finalState` field SHALL be `null`, indicating a partial run

---

### Requirement: A human-readable summary can be printed from the bundle
The pipeline CLI SHALL support a `--summary <issueNumber>` flag. When this flag is present, the CLI SHALL resolve the evidence bundle for the given issue using the following priority order, print a human-readable summary (at minimum: run identity, per-stage outcome table, review verdict list, override list, and final state), and exit without entering the dispatch loop.

**Bundle resolution priority for `--summary <issueNumber>`:**
1. The CLI SHALL scan `.agent-pipeline/runs/` for all run directories whose run-id begins with `<issueNumber>-` (i.e. `listRunIds(repoDir)` filtered by issue prefix, sorted by mtime descending) and read `summary.json` from the most-recent matching entry.
2. If no run-directory `summary.json` is readable for the issue (absent, corrupt, or parse error), the CLI SHALL fall back to `<stateDir>/<issueNumber>/evidence.json` (the legacy path).
3. If neither location yields a readable bundle, the CLI SHALL exit non-zero and print an error message that names both the run-directory path and the legacy path.

A `summary.json` that exists but cannot be parsed (corrupt JSON or missing required fields) SHALL be treated as absent for fallback purposes — the CLI SHALL not crash and SHALL proceed to the legacy fallback.

**Exact run selection:** The CLI SHALL additionally accept `pipeline summary <run-id>` as a positional sub-command (no issue number, no `--summary` flag). When invoked with a run-id argument, the CLI SHALL read `summary.json` from `.agent-pipeline/runs/<run-id>/` and print the human-readable summary. The `--domain` flag SHALL NOT affect this path; the run directory is located from the repo root alone.

#### Scenario: --summary prints from run-directory summary.json when available
- **WHEN** `pipeline --summary 147` is invoked
- **AND** `.agent-pipeline/runs/` contains at least one directory matching `147-*` with a readable `summary.json`
- **THEN** the CLI SHALL read `summary.json` from the most-recent such directory (by mtime)
- **AND** the output SHALL include the `runId`, `issue`, `branch`, each stage name and its `outcome`, and `finalState`

#### Scenario: --summary falls back to legacy path when no run-directory summary exists
- **WHEN** `pipeline --summary 147` is invoked
- **AND** no `147-*/summary.json` is readable under `.agent-pipeline/runs/`
- **AND** `<stateDir>/147/evidence.json` exists and is valid
- **THEN** the CLI SHALL read and print the legacy bundle without error
- **AND** the process SHALL exit with code 0

#### Scenario: --summary treats corrupt run-directory summary.json as absent
- **WHEN** `pipeline --summary 147` is invoked
- **AND** the latest `147-*/summary.json` under `.agent-pipeline/runs/` exists but contains invalid JSON
- **THEN** the CLI SHALL fall back to the legacy `<stateDir>/147/evidence.json`
- **AND** SHALL NOT crash or emit an unhandled exception

#### Scenario: --summary exits non-zero with informative error when no bundle found
- **WHEN** `pipeline --summary 147` is invoked
- **AND** no readable bundle exists at either the run-directory or legacy location
- **THEN** the process SHALL exit with a non-zero code
- **AND** the error message SHALL name both the run-directory path (`.agent-pipeline/runs/147-*/summary.json`) and the legacy path

#### Scenario: --summary exits zero when bundle exists
- **WHEN** `pipeline --summary <N>` is invoked and a bundle exists for issue N (at either location)
- **THEN** the process SHALL exit with code 0

#### Scenario: --summary exits non-zero when no bundle
- **WHEN** `pipeline --summary <N>` is invoked and no bundle exists for issue N
- **THEN** the process SHALL exit with a non-zero code and print an error message

#### Scenario: pipeline summary <run-id> reads exact run directory
- **WHEN** `pipeline summary <run-id>` is invoked with a known run-id
- **AND** `.agent-pipeline/runs/<run-id>/summary.json` exists and is valid
- **THEN** the CLI SHALL print the human-readable summary from that file
- **AND** the process SHALL exit with code 0

#### Scenario: pipeline summary <run-id> exits non-zero for unknown run-id
- **WHEN** `pipeline summary <run-id>` is invoked with a run-id that has no matching directory or lacks a `summary.json`
- **THEN** the process SHALL exit with a non-zero code and print an error message naming the expected path

#### Scenario: pipeline summary <run-id> is domain-independent
- **WHEN** `pipeline summary <run-id>` is invoked without a `--domain` flag
- **THEN** the CLI SHALL locate the run directory from the repo root (`.agent-pipeline/runs/<run-id>/`) without consulting any domain config

### Requirement: PR or issue receives a single path-notification comment at finalization

After `finalizeBundle()` succeeds, the pipeline SHALL post a comment on the PR (or issue if
no PR is open) that is self-contained on GitHub. The comment body SHALL include: (a) the run
id as a visibly labeled field (not only embedded inside a file path); (b) a per-stage timing
table rendered in Markdown with one row per recorded stage, each row showing the stage name,
its `enteredAt`→`exitedAt` timestamps, the stage duration, the stage's harness invocation
duration, and the stage outcome; and (c) the local file path of the run-directory bundle
(and/or the `pipeline N --summary` hint) as secondary/optional context. The timing table, run
id, and outcome SHALL be complete and correct using only data carried in the comment body —
no field in the table SHALL depend on local filesystem access to render. The comment SHALL be
posted at most once per run: if the bundle already records a notification, the comment SHALL
be skipped on subsequent finalization calls. The comment body SHALL be derived solely from
the finalized bundle's stage/timing/outcome and identity fields, plus the wall-clock
`duration_ms` of harness invocations recorded for each stage, and SHALL NOT include
accounting payloads (token counts, cost values, prompts, responses, transcripts, or provider
payloads).

#### Scenario: comment posted at finalization with run id and timing table

- **WHEN** `finalizeBundle()` is called and no prior notification is recorded in the bundle
- **THEN** the orchestrator SHALL post a comment whose body contains the run id as a labeled
  field
- **AND** the body SHALL contain a Markdown table with one row per recorded stage showing
  stage name, `enteredAt`→`exitedAt`, duration, harness invocation duration, and outcome
- **AND** the body SHALL still reference the local run-directory bundle path (or the
  `pipeline N --summary` hint) as secondary context
- **AND** the bundle SHALL record a `notifiedAt` timestamp after posting

#### Scenario: timing table renders without local filesystem access

- **WHEN** the finalization comment is rendered for a run whose local run directory is later
  unavailable (e.g. viewed from a different machine)
- **THEN** the run id, per-stage timing table, and outcome in the comment body SHALL remain
  complete and correct
- **AND** no field in the table SHALL require reading `.agent-pipeline/runs/` or the legacy
  evidence path to display

#### Scenario: comment omits accounting data

- **WHEN** finalization posts the comment for a run that recorded accounting data
- **THEN** the comment body SHALL NOT contain token counts, cost values, prompts, responses,
  transcripts, provider payloads, or secret values
- **AND** the comment body SHALL contain only wall-clock stage and harness-invocation
  durations, the run id, and the local path reference

#### Scenario: comment not re-posted

- **WHEN** `finalizeBundle()` is called and `notifiedAt` is already set in the bundle
- **THEN** the orchestrator SHALL NOT post another comment

### Requirement: The evidence bundle is a supplement; removing it does not affect pipeline behavior
The evidence bundle SHALL be written to disk only. No pipeline logic SHALL read the bundle to make label-transition, blocking, or routing decisions. The authoritative state for the pipeline SHALL remain GitHub labels and comments. Deleting or corrupting the bundle file SHALL have zero effect on the pipeline's ability to continue a run.

#### Scenario: bundle absent — pipeline continues normally
- **WHEN** the bundle file does not exist or cannot be read at the start of a stage
- **THEN** the stage SHALL proceed normally without error
- **AND** SHALL attempt to create or recreate the bundle if it is missing

### Requirement: Evidence bundle carries a schema_version field
The evidence bundle JSON object SHALL include a top-level `schema_version` integer
field. The initial value SHALL be `1`. This aligns the bundle with the cross-cutting
`run-artifact-conventions` spec. The existing `schemaVersion` field (camelCase) is
an alias; both SHALL be treated as equivalent during a transitional period and
documented as such in the README.

#### Scenario: bundle created with schema_version present
- **WHEN** `createBundle()` writes the initial evidence bundle JSON
- **THEN** the resulting object SHALL contain `"schema_version": 1`

#### Scenario: existing schemaVersion field is not removed
- **WHEN** the bundle is read by a consumer that only knows the old `schemaVersion` field name
- **THEN** the consumer SHALL still find `"schemaVersion": 1` (both fields co-exist during the transitional period)

---

### Requirement: Evidence bundle writes are non-fatal
Evidence bundle writes SHALL satisfy the non-fatal I/O contract defined in the
`run-artifact-conventions` spec: errors from creation, stage recording, or
finalization are caught, logged as warnings, and do not propagate to the calling stage.

#### Scenario: bundle write error does not fail the stage
- **WHEN** writing to the evidence bundle file throws an error (e.g., stateDir not writable)
- **THEN** the stage that triggered the write SHALL continue and complete normally
- **AND** a warning SHALL be logged with the error detail

---

### Requirement: Evidence bundle records pass the write-time injection denylist
Evidence bundle records SHALL pass through the write-time injection denylist defined
in `run-artifact-conventions` before being appended. Matching content SHALL be replaced
with `[REDACTED-INJECTION]`; the record SHALL be written with the substitution in place.

#### Scenario: injected content in a CommandRecord output is redacted
- **WHEN** a command's stdout contains a string matching an injection denylist pattern
- **THEN** the matching span in `outputExcerpt` SHALL be replaced with `[REDACTED-INJECTION]`
- **AND** the CommandRecord SHALL still be appended to the bundle

#### Scenario: clean records are unaffected
- **WHEN** no field in a bundle record matches any injection pattern
- **THEN** the record SHALL be written without modification

### Requirement: Override records carry an optional kind field from the taxonomy
Each `OverrideRecord` appended to the evidence bundle SHALL carry an optional `kind` field of type `HumanInterventionKind`. When an operator override is recorded, the engine SHALL set `kind: "human-risk-override"`. The field is optional for backward compatibility: existing records without `kind` remain valid, and consumers SHALL treat an absent `kind` as `"unknown"`.

#### Scenario: operator override record includes kind field
- **WHEN** an operator supplies `--override "<key>: <reason>"`
- **THEN** the `OverrideRecord` written to `summary.json` SHALL contain `kind: "human-risk-override"`
- **AND** all existing override fields (`key`, `reason`, `at`, `sha`) SHALL remain present and unchanged

#### Scenario: override record without kind is treated as unknown by consumers
- **WHEN** a consumer reads an `OverrideRecord` that has no `kind` field (e.g. written by an older engine version)
- **THEN** the consumer SHALL treat the absent `kind` as `"unknown"` for aggregation
- **AND** it SHALL NOT throw or fail due to the missing field

### Requirement: summary.json includes a top-level interventions array at finalization
When `finalizeRun()` is called, `summary.json` SHALL include a top-level `interventions` field containing the array of all `human_intervention` event objects recorded during the run. This field is additive and optional: consumers that do not recognize it SHALL ignore it. The `interventions` array SHALL be the same records as the `human_intervention` events in `events.jsonl` for the same run, in chronological order.

#### Scenario: summary.json interventions matches events.jsonl human_intervention events
- **WHEN** `finalizeRun()` writes `summary.json` after a run with N `human_intervention` events
- **THEN** `summary.json` SHALL contain an `interventions` array with N objects
- **AND** each object in `interventions` SHALL be identical to the corresponding `human_intervention` line in `events.jsonl`

#### Scenario: summary.json with no interventions includes empty interventions array
- **WHEN** no `human_intervention` events were emitted during a run
- **THEN** `summary.json` SHALL contain `"interventions": []`
- **AND** `schema_version` SHALL remain `1`

### Requirement: summary.json includes finalized stage accounting records

When `finalizeRun()` writes `summary.json`, the evidence bundle SHALL include a
top-level `accounting` object. `accounting.records` SHALL contain the run's
stage accounting records in chronological order. `accounting.totals` SHALL
contain at minimum `record_count`, `actual_cost_usd`, `estimated_cost_usd`, and
`unknown_cost_count`. The legacy `<stateDir>/<issueNumber>/evidence.json` SHALL
receive the same `accounting` object because it mirrors `summary.json`.

The accounting object is additive: existing consumers that ignore unknown fields
SHALL continue to function.

#### Scenario: Finalized summary contains accounting records and totals

- **WHEN** `finalizeRun()` writes `summary.json` after a run with two
  `stage_accounting` events
- **THEN** `summary.json.accounting.records` SHALL contain two records in
  chronological order
- **AND** `summary.json.accounting.totals.record_count` SHALL equal `2`

#### Scenario: Legacy evidence mirrors accounting object

- **WHEN** finalization writes both `summary.json` and
  `<stateDir>/<issueNumber>/evidence.json`
- **THEN** the legacy `evidence.json` SHALL contain the same `accounting`
  object as `summary.json`

#### Scenario: Unknown cost contributes to unknown count

- **WHEN** a finalized run has one accounting record with
  `cost_source: "unknown"`
- **THEN** `summary.json.accounting.totals.unknown_cost_count` SHALL include
  that record
- **AND** the unknown record SHALL NOT add `0` to `actual_cost_usd` or
  `estimated_cost_usd`

### Requirement: Public finalization comments do not include accounting payloads

The PR or issue notification comment posted at finalization SHALL NOT include
raw accounting records, usage-derived token/cost payloads, prompts, responses,
transcripts, provider payloads, or secret values. It MAY continue to include the
local bundle path as specified by the existing evidence notification contract.

#### Scenario: Finalization comment omits accounting data

- **WHEN** finalization posts a PR or issue comment for a run with accounting
  records
- **THEN** the comment SHALL NOT contain any raw accounting record JSON
- **AND** the comment SHALL NOT contain token counts, cost values, prompts,
  responses, transcripts, provider payloads, or secret values derived from usage
  logs

### Requirement: Evidence bundle MAY contain an auto_merge_eligibility artifact record
When the auto-merge eligibility gate runs and produces a verdict, the evidence bundle SHALL record the result as an `auto_merge_eligibility` field on the accumulated stage data, written via the existing record API before `finalizeRun()` writes `summary.json`. The field SHALL be absent (not `null`) when the gate is disabled.

The `auto_merge_eligibility` artifact record SHALL conform to the `AutoMergeEligibilityArtifact` schema defined in `auto-merge-eligibility-schema.ts`. Its required fields are: `eligibility`, `evaluated_at`, `deterministic_checks`, `denial_reasons`, `judge_output`, `ci_status_snapshot`, `review_verdict_snapshot`, `linked_run_id`, `linked_issue`, `linked_pr`, and `revert_note` (see the `auto-merge-eligibility` capability spec for the full field definitions).

#### Scenario: artifact present in summary.json when gate ran
- **WHEN** `auto_merge_eligibility.enabled: true` and the gate completes successfully
- **THEN** `summary.json` SHALL contain an `auto_merge_eligibility` field with all required subfields

#### Scenario: artifact absent when gate is disabled
- **WHEN** `auto_merge_eligibility.enabled: false`
- **THEN** `summary.json` SHALL NOT contain an `auto_merge_eligibility` field

#### Scenario: artifact written before finalization
- **WHEN** the gate runs inside `shipcheck-gate`
- **THEN** the artifact SHALL be recorded before `finalizeRun()` is called
- **AND** SHALL appear in both `summary.json` and the legacy `evidence.json`

### Requirement: Bundle records the design-interrogation chain

The evidence bundle SHALL carry a `designInterrogation` record for every run that reaches the
`design-gate` stage. When the gate does not fire, the record SHALL contain `triggered: false` and the
reason (`gate-disabled` or `no-trigger-matched`) and nothing else. When the gate fires, the record
SHALL additionally contain: the matched triggers with their evidence, `reviewerIdentity`
(harness, model, effort) and `reviewerIndependence`, every version of the decision record, every
round's challenges (each with `challengeKey`, severity, confidence, blocking-vs-advisory disposition,
and `required_action`), the implementer's response for each challenge with its final disposition, and
the gate's final outcome (`advanced`, `parked-needs-human`, or `blocked`). The record SHALL be subject
to the bundle's existing secret-redaction rules and SHALL contain no raw hidden model reasoning.

#### Scenario: untriggered run records only the reason
- **WHEN** the gate is disabled and the run finalizes
- **THEN** `summary.json` SHALL contain a `designInterrogation` record with `triggered: false` and reason `gate-disabled`
- **AND** the record SHALL contain no decision record, challenges, or reviewer identity

#### Scenario: triggered run records the full chain
- **WHEN** the gate fires, the reviewer returns challenges, and the implementer responds
- **THEN** `summary.json` SHALL contain the matched triggers, the reviewer identity and independence value, each decision-record version, each round's challenges with their keys and dispositions, the implementer responses, and the final gate outcome

#### Scenario: parked run records the unresolved punch list
- **WHEN** the gate parks at `needs-human`
- **THEN** the `designInterrogation` record SHALL carry outcome `parked-needs-human`
- **AND** SHALL list each unresolved blocking challenge with its `challengeKey`, severity, and `required_action`

#### Scenario: redaction applied
- **WHEN** any part of the chain contains a value matching the engine's secret patterns
- **THEN** the persisted bundle SHALL carry the redacted form

---

### Requirement: The human-readable summary SHALL render the design-interrogation outcome

The run summary posted for the issue SHALL include a design-interrogation section whenever the gate
fired, naming the matched trigger classes, the reviewer identity with any same-harness fallback
disclosure, the count of blocking and advisory challenges, each challenge's final disposition, and any
explicitly accepted uncertainty. When the gate did not fire, the summary SHALL state the one-line
reason rather than omitting the gate entirely.

#### Scenario: fired gate rendered in the summary
- **WHEN** the gate fired and the run finalizes
- **THEN** the posted summary SHALL contain a design-interrogation section with the matched triggers, reviewer identity, challenge counts, and per-challenge dispositions

#### Scenario: same-harness fallback disclosed in the summary
- **WHEN** the gate ran under `same-harness-fallback`
- **THEN** the summary section SHALL state the fallback explicitly

#### Scenario: untriggered gate rendered as a one-line reason
- **WHEN** the gate did not fire
- **THEN** the summary SHALL contain a one-line design-gate reason (`gate-disabled` or `no-trigger-matched`)

