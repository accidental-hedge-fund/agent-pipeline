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

### Requirement: summary.json SHALL record pre-merge delta-round accounting

When a run performs at least one pre-merge delta round, `summary.json` SHALL include a delta-round accounting record carrying: the durable delta-round count observed for the item, the configured `review_policy.max_delta_rounds` cap, the ceiling disposition when the cap was reached (the applied `ceiling_action` and whether the item parked or advanced), and the rounds flagged as suspected churn with their involved axes. The human-readable summary SHALL render the count, the cap, and any ceiling disposition. Recording this accounting SHALL be non-fatal: a write failure SHALL NOT fail the run or change the pre-merge outcome.

#### Scenario: Bundle reports count, cap, and ceiling disposition

- **WHEN** a run performs delta rounds and reaches the configured cap
- **THEN** `summary.json` SHALL report the observed delta-round count, the cap, and the applied `ceiling_action` with the resulting disposition

#### Scenario: Churn flags are recorded

- **WHEN** a delta round was flagged as suspected churn
- **THEN** `summary.json` SHALL list that round among the suspected-churn rounds with its involved axes

#### Scenario: Human-readable summary renders the accounting

- **WHEN** the human-readable summary is printed for a run that performed delta rounds
- **THEN** it SHALL show the delta-round count, the cap, and any ceiling disposition

#### Scenario: No delta rounds — no record required

- **WHEN** a run performs no pre-merge delta rounds
- **THEN** `summary.json` SHALL be valid without a delta-round accounting record

#### Scenario: Write failure is non-fatal

- **WHEN** writing the delta-round accounting record fails
- **THEN** the run SHALL continue and the pre-merge outcome SHALL be unchanged

### Requirement: Finalized evidence bundle SHALL include event-stream write-health

The finalized evidence bundle SHALL include the run's event-stream write-health state when
`finalizeRun` writes `summary.json` (and the legacy evidence path). When write-health recorded one
or more failures during the run, the bundle SHALL expose that elevated state so operators and
`pipeline summary` can detect empty, truncated, or partially lost event streams even when
`finalState` reflects a successful stage outcome. When no failures were recorded, the bundle SHALL
expose a healthy or zero-failure write-health representation. The addition is additive and SHALL NOT
change the evidence bundle `schema_version` meaning for existing fields.

#### Scenario: summary.json carries write-health after append failures

- **WHEN** `finalizeRun` is called for a run that recorded at least one `appendEvent` durable
  delivery failure
- **THEN** `summary.json` SHALL include write-health indicating failure
- **AND** a consumer of `pipeline summary` SHALL be able to observe the failure without reading
  stderr from the original process

#### Scenario: healthy run finalizes with non-elevated write-health

- **WHEN** `finalizeRun` is called for a run with no recorded append failures
- **THEN** `summary.json` SHALL include write-health in a healthy or zero-failure state
- **AND** SHALL still include existing finalization fields (`finalState`, `finalizedAt`, stage
  history)

#### Scenario: Successful finalState does not hide write-health failure

- **WHEN** a run reaches a successful terminal stage outcome and `finalizeRun` sets a successful
  `finalState`
- **AND** write-health recorded control-critical or best-effort append failures during the run
- **THEN** `summary.json` SHALL still expose the elevated write-health
- **AND** SHALL NOT omit or clear write-health solely because `finalState` is successful

### Requirement: Run evidence surfaces SHALL persist full Tester evidence

The pipeline SHALL persist the full structured `TesterEvidence` record in the
run evidence surfaces under the existing run directory layout when that record
is produced for a run (for example a dedicated file such as
`tester-evidence.json` and/or inclusion in `summary.json`), and SHALL append a
structured event to `events.jsonl` that references or embeds the Tester outcome
fields needed by consumers. Persistence SHALL apply the same secret-redaction
and injection-denylist rules as other evidence-bundle string fields. A human
summary comment, when posted, is not a substitute for the full structured
record.

#### Scenario: full record present in the run directory after production

- **WHEN** the deterministic producer writes Tester evidence for run `R`
- **THEN** the run directory for `R` SHALL contain the full structured
  `TesterEvidence` record (dedicated file and/or `summary.json` field)
- **AND** the persisted payload SHALL include `candidate_sha`,
  `overall_status`, `commands`, and timing fields

#### Scenario: events.jsonl carries a tester evidence signal

- **WHEN** Tester evidence is successfully written for a run
- **THEN** `events.jsonl` SHALL include an event that identifies the Tester
  outcome (at least overall status, candidate SHA, and duration or equivalent)
- **AND** consumers SHALL NOT need to parse a GitHub comment to learn that
  status

#### Scenario: write failure does not pretend success

- **WHEN** persisting Tester evidence fails after a suite run
- **THEN** the pipeline SHALL surface an operator-visible write-health or
  artifact-write failure signal consistent with existing run-store write-health
  dispositions
- **AND** SHALL NOT claim that the full structured record was stored when it
  was not

#### Scenario: secrets are not stored in the bundle form

- **WHEN** Tester command output contains a secret matching redaction rules
- **THEN** the evidence-bundle copy of the Tester record SHALL contain the
  redacted placeholder
- **AND** SHALL NOT contain the raw secret value

### Requirement: Evidence bundle SHALL surface candidate-integrity transitions

The durable run evidence trail (run ledger and, when a JSON evidence bundle is written, the bundle or its linked event stream) SHALL record `candidate_integrity` transitions produced by the candidate-integrity protocol. Recorded fields SHALL include before/after candidate SHAs, mutation method, classification, bounded changed-path summary, and review/readiness invalidation reason or flags when invalidation occurs. Evidence writes remain non-fatal to pipeline control flow under existing evidence-bundle rules, but the control-plane invalidation disposition itself is authoritative from the integrity protocol, not from optional bundle presence.

#### Scenario: Bundle or ledger includes a scope-expansion event

- **WHEN** a covered mutation classifies as `scope_expansion` during a run that records durable events
- **THEN** a `candidate_integrity` event with that classification and before/after SHAs SHALL appear in the durable event stream
- **AND** when an evidence bundle is finalized for that run, the transition SHALL be discoverable from the bundle or its linked events without requiring a separate human diary

#### Scenario: Missing optional bundle does not clear integrity invalidation

- **WHEN** candidate-integrity invalidates readiness for a head
- **AND** evidence-bundle write is skipped or fails non-fatally
- **THEN** the invalidation disposition SHALL still hold
- **AND** the run ledger event (when the ledger is available) remains the primary durable record for scoreboard consumers

### Requirement: Finalized evidence bundles SHALL expose evidence_subject mismatch diagnostics

When `finalizeRun` / `finalizeBundle` writes `summary.json` (and the legacy `evidence.json` mirror), the finalized bundle SHALL include a structured diagnostics collection for readiness-relevant artifacts that records subject comparison against the run’s evaluation pin subject (or the best-known pin at finalization). Each diagnostic entry SHALL include at least: artifact kind or reference, whether `evidence_subject` was present, comparison outcome (`match` | `mismatch` | `malformed` | `legacy_unbound`), and `mismatched_fields` (empty array on match or when not applicable). The bundle SHALL retain enough echoed subject field values that a dossier consumer can see which dimensions differed without recomputing digests from source trees. Project Warrant and other aggregators MUST NOT invent or repair subjects; they consume these diagnostics as written.

#### Scenario: finalize records match diagnostics for co-current evidence

- **WHEN** a run finalizes with review and tester artifacts whose subjects match the evaluation pin
- **THEN** `summary.json` SHALL contain diagnostic entries for those artifacts with outcome `match`
- **AND** `mismatched_fields` SHALL be empty for those entries

#### Scenario: finalize records field-level mismatch diagnostics

- **WHEN** a run finalizes with an artifact whose subject differs from the evaluation pin only on `policy_hash`
- **THEN** the diagnostic entry for that artifact SHALL have outcome `mismatch`
- **AND** `mismatched_fields` SHALL include `policy_hash`

#### Scenario: finalize labels legacy unbound artifacts

- **WHEN** a run finalizes with a historical readiness artifact that has no `evidence_subject`
- **THEN** the diagnostic entry SHALL have outcome `legacy_unbound`
- **AND** SHALL NOT report outcome `match`

#### Scenario: diagnostics do not require external recompute

- **WHEN** a dossier consumer reads the finalized diagnostics for a mismatched artifact
- **THEN** it SHALL be able to identify the mismatched field names from the diagnostic entry
- **AND** SHALL NOT need to re-hash policy, engine, or diff inputs to detect the mismatch when both subjects were recorded

---

### Requirement: Bundle review and override records SHALL carry evidence_subject when newly written

When the evidence bundle records a new `ReviewRecord` or a new override disposition that participates in readiness composition, the written record SHALL include a nested `evidence_subject` (or a pointer to the same subject object on the related review artifact) built from authoritative runtime state at record time. Existing review fields such as `sha` SHALL remain and SHALL stay consistent with `evidence_subject.candidate_sha` when the subject is present. Missing subjects on newly written readiness-relevant rows after this change SHALL be treated as producer defects (malformed/quarantine), not as silent matches.

#### Scenario: new review row in the bundle includes subject identity

- **WHEN** `recordReview()` records a review round into the in-memory bundle during a run that implements subject emission
- **THEN** the corresponding `ReviewRecord` SHALL carry `evidence_subject` with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal the recorded review `sha`

#### Scenario: new override row binds subject when readiness-relevant

- **WHEN** an override is applied and recorded into the bundle for readiness composition
- **THEN** the override record SHALL carry an `evidence_subject` (or explicit link to the bound review subject) derived from runtime state
- **AND** SHALL NOT rely on free-text override reason text as subject identity

### Requirement: Evidence bundle SHALL record the trusted-surface decision and effective verifier identity

When a run computes a trusted-surface decision, the finalized evidence bundle (`summary.json` and the legacy `evidence.json` mirror) SHALL include a structured `trusted_surface` record (or equivalent documented key) carrying at least: `schema_version`, `outcome` (`passthrough` | `rebound` | `blocked`), `path_class_schema_version`, `candidate_sha`, `base_sha` when known, `triggering_paths`, `effective_verifier_hash` when resolved, per-class trusted source and content hash summaries, and `reason`. The record SHALL be written by deterministic engine code from the decision object — not from harness prose. An external consumer (including Project Warrant) SHALL be able to read which verifier surface judged the run without recomputing path classification or content hashes from source trees when the record is present. When no decision was computed (historical runs), the field MAY be absent; consumers MUST NOT invent a `passthrough` outcome for missing records.

#### Scenario: rebound decision appears in summary

- **WHEN** a run finalizes with trusted-surface `outcome` `rebound` and effective verifier hash H
- **THEN** `summary.json` SHALL include a `trusted_surface` object with `outcome` `rebound`
- **AND** `effective_verifier_hash` SHALL equal H
- **AND** `triggering_paths` SHALL be non-empty

#### Scenario: passthrough decision is explicit

- **WHEN** a run finalizes with trusted-surface `outcome` `passthrough`
- **THEN** `summary.json` SHALL record `outcome` `passthrough`
- **AND** `triggering_paths` SHALL be empty

#### Scenario: missing historical record is not synthesized as passthrough by the bundle writer

- **WHEN** a historical finalized bundle predates trusted-surface recording
- **THEN** the bundle MAY omit `trusted_surface`
- **AND** a later reader SHALL NOT treat omission as an implicit successful `passthrough` claim without an explicit legacy rule

#### Scenario: blocked decision is visible for dossier consumers

- **WHEN** a run ends with trusted-surface `outcome` `blocked`
- **THEN** the finalized bundle SHALL include `outcome` `blocked` and a non-empty reason
- **AND** Project Warrant or other consumers SHALL be able to refuse readiness claims by reading that field without recomputing the decision

### Requirement: Evidence bundle SHALL record pre-code attestation gate outcomes

The evidence bundle SHALL record a pre-code attestation section for every run that reaches the
`pre-code-attestation` stage position. The section SHALL include at least: whether the gate was
enabled, the trigger evaluation result (`triggered`, `matched`, `reason`), and when triggered: dossier
revision or content hash, attestation decision records (if any), authorization resolution summary,
and wait or integrity outcome codes. Inert skips SHALL still record `gate-disabled` or
`no-trigger-matched`.

#### Scenario: inert skip recorded

- **WHEN** the pre-code attestation stage advances with reason `gate-disabled`
- **THEN** the finalized evidence bundle SHALL include that reason under the pre-code attestation section

#### Scenario: approve recorded with hashes

- **WHEN** a triggered run accepts an approve attestation
- **THEN** the evidence bundle SHALL include the dossier hash/revision, policy hash/revision, actor, decision, and authorization resolution summary

#### Scenario: reject and unauthorized attempts preserved

- **WHEN** a reject decision or unauthorized approve attempt occurs
- **THEN** the evidence bundle SHALL preserve that outcome
- **AND** SHALL NOT omit it solely because implementing never started

---

### Requirement: Evidence bundle SHALL record contract-to-evidence trace rows for triggered runs

For triggered runs with an approved dossier, the evidence bundle SHALL include trace rows mapping
each accepted `objective_id` (and content hash) to its final verification status: verified by
repo-native evidence, `unverified_exception` for affirmed `Untestable:` cases, or missing. Missing
required traces SHALL be visible as failures, not silent omissions.

#### Scenario: verified objective row

- **WHEN** an approved objective has matching final test or eval evidence
- **THEN** the bundle trace row SHALL mark it verified with a reference to that evidence

#### Scenario: untestable exception row

- **WHEN** an approved objective carries an affirmed `Untestable:` exception
- **THEN** the bundle trace row SHALL mark `unverified_exception`
- **AND** SHALL NOT mark it as test-proven

#### Scenario: missing trace is visible

- **WHEN** an approved objective has no verification evidence and no untestable exception
- **THEN** the bundle SHALL record the objective as missing verification
- **AND** readiness composition consumers SHALL be able to fail safely on that row
)

### Requirement: Evidence bundle SHALL record human-question handoff lifecycle outcomes

When a run creates, answers, rejects, supersedes, expires, or attempts resume validation on a human-question handoff, the evidence bundle (or its run-scoped companion artifacts referenced from the bundle) SHALL record the handoff id, class, authority mode, status transition, actor when present, candidate SHA and bound content hashes, and resume validation result. Handoff evidence is a supplement: missing write of optional display fields SHALL NOT by itself clear a required human hold, and removing the bundle SHALL NOT delete the durable handoff store used for resume.

#### Scenario: Create is visible in evidence

- **WHEN** a handoff is created during a pipeline run that finalizes an evidence bundle
- **THEN** the bundle or its referenced handoff evidence SHALL include the new handoff id and `pending` status
- **AND** SHALL include class and authority_mode

#### Scenario: Resume refusal is recorded

- **WHEN** resume validation fails for stale SHA or superseded status
- **THEN** evidence SHALL record the refusal reason
- **AND** SHALL NOT record a successful advance for that attempt

#### Scenario: Answer provenance is recorded

- **WHEN** an eligible actor answers a handoff
- **THEN** evidence SHALL include responder identity reference, decision, and timestamp
- **AND** SHALL include whether the handoff was authority-bearing


### Requirement: Evidence bundle SHALL record governed override decisions and lifecycle state

The evidence bundle (or equivalent run evidence surface) SHALL include override decision records sufficient to distinguish `active`, `expired`, `superseded`, `renewed`, `rejected`, and `invalidated` outcomes for the run. Each recorded decision SHALL expose class, target, actor, authorization summary, timestamps (`created_at`, `expires_at`), lineage identifiers when present, evidence and remediation references, and evidence-subject binding or legacy-unbound disposition. Free-text reasons alone SHALL NOT be the only machine-readable representation of lifecycle state.

#### Scenario: active and expired decisions appear distinctly

- **WHEN** a run recorded one still-active decision and one expired decision
- **THEN** the evidence bundle SHALL list both
- **AND** their lifecycle fields SHALL differ (`active` vs `expired`)

#### Scenario: rejected attempt is visible

- **WHEN** an override recording attempt is refused for unauthorized or missing-evidence reasons
- **THEN** the run evidence or event stream SHALL retain a rejected outcome record for analysis
- **AND** SHALL NOT imply the finding was dispositioned

#### Scenario: renewal lineage is visible

- **WHEN** decision D2 renews D1
- **THEN** evidence SHALL allow a consumer to read D2’s link to D1
- **AND** to see both records without in-place mutation of D1

### Requirement: Evidence bundle SHALL support age and recurrence analysis fields

For each override decision in evidence, the bundle or accompanying machine-readable events SHALL include enough structured fields for consumers to compute decision age, class, authority actor, renewal count or lineage depth, and correlation to the finding or scope target for recurrence analysis.

#### Scenario: age and class are structured

- **WHEN** a consumer reads an override decision from the evidence bundle
- **THEN** it SHALL obtain `created_at`, `expires_at`, and `class` without parsing the human explanation paragraph
- **AND** SHALL obtain the target key or scope identity as structured fields

### Requirement: Finalized evidence SHALL record staged policy effective state and policy hash

When staged policies are in scope for a run, `summary.json` (and the legacy `evidence.json` mirror written at finalization) SHALL include a machine-readable section listing each in-scope policy with at least `policy_id`, effective lifecycle `state`, and `policy_hash`. Absent staged-policy configuration SHALL omit the section or emit an empty list without inventing policies.

#### Scenario: Enforcing policy appears in finalized evidence

- **WHEN** `finalizeRun` completes for a run with an in-scope policy in state `enforcing`
- **THEN** the finalized evidence SHALL contain that policy’s `policy_id`, `state`, and `policy_hash`

#### Scenario: No staged policies configured

- **WHEN** a run finalizes with no staged-policy configuration
- **THEN** the evidence SHALL NOT invent policy entries
- **AND** finalization SHALL still succeed

---

### Requirement: Finalized evidence SHALL record repository-control drift results

When repository-control desired state is configured and a compare runs during the run (or is attached from the read-only check path into run evidence), `summary.json` / legacy `evidence.json` SHALL include structured drift results with closed `outcome` values (`in_sync` | `drifted` | `unknown` | `unsupported` | `unavailable`), field-level differences when drifted, freshness metadata, repository identity, policy identity when bound, live snapshot reference or digest, timestamp, and evidence-subject identity when a candidate run context exists.

#### Scenario: Drifted compare recorded at finalize

- **WHEN** a run performs repository-control compare with outcome `drifted`
- **AND** `finalizeRun` is called
- **THEN** finalized evidence SHALL include a drift result with `outcome: "drifted"` and non-empty field-level differences

#### Scenario: Unavailable live read recorded distinctly

- **WHEN** live read fails due to permissions during the run
- **THEN** finalized evidence SHALL record `outcome: "unavailable"`
- **AND** SHALL NOT record that control as `in_sync`


### Requirement: Evidence surfaces SHALL expose lineage export slices and drift reason codes

When lineage data exists for a run, finalized evidence surfaces (evidence bundle and/or `summary.json` and the human-readable summary path) SHALL expose a lineage section that includes at least:

- schema version of the lineage export slice
- counts of nodes and edges relevant to the run (or explicit zero with reason)
- key objective ids linked to the run when present
- any computed forward impact or backward proposal references for the run
- stable drift reason codes when impact analysis was run

Absence of a hosted UI SHALL NOT prevent operators from reading these fields via JSON or human-readable summary. Missing lineage for a run SHALL be explicit (empty section or skip reason), not silent success that implies complete attribution.

#### Scenario: human-readable summary includes drift codes when impact ran

- **WHEN** forward impact analysis records `objective_content_hash_changed` for a run's objective
- **AND** the human-readable summary is printed
- **THEN** the summary SHALL include that drift reason code
- **AND** SHALL name the affected objective id or bounded summary

#### Scenario: JSON export is available without UI

- **WHEN** an operator requests lineage or evidence JSON for a run with projected edges
- **THEN** the export SHALL include the lineage section fields above
- **AND** SHALL be consumable without a hosted UI

#### Scenario: missing lineage is explicit

- **WHEN** a run finalizes before any lineage projection exists
- **THEN** the evidence surface SHALL omit the section or record an explicit skip/empty reason
- **AND** SHALL NOT claim complete intent-to-outcome attribution
