# evidence-bundle Specification

## Purpose
TBD - created by archiving change evidence-bundle. Update Purpose after archive.
## Requirements
### Requirement: Pipeline run writes a JSON evidence bundle to a stable, issue-scoped path
The pipeline orchestrator SHALL create a JSON evidence bundle at `<stateDir>/<issueNumber>/evidence.json` at the start of each dispatch cycle. The path SHALL be deterministic and issue-scoped so the same file is updated across stages within a single run.

#### Scenario: bundle created at dispatch entry
- **WHEN** the pipeline orchestrator begins dispatching for issue N
- **THEN** a JSON file SHALL exist at `<stateDir>/N/evidence.json` before any stage handler is called
- **AND** the file SHALL be valid JSON with `"schemaVersion": 1`

#### Scenario: bundle directory created if absent
- **WHEN** `<stateDir>/N/` does not exist at dispatch entry
- **THEN** the orchestrator SHALL create the directory before writing the bundle

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
For each pipeline stage, the bundle SHALL record: `stage` (the stage name string), `enteredAt` (ISO 8601 timestamp when the stage handler was entered), `exitedAt` (ISO 8601 timestamp when the stage handler returned), `outcome` (one of `"advanced"`, `"blocked"`, `"skipped"`, or `"error"`), `commits` (array of commit SHA strings produced during the stage), `commands` (array of `CommandRecord` objects), and `prompts` (array of `PromptRecord` objects recorded at each harness invocation).

#### Scenario: stage entry recorded
- **WHEN** a stage handler calls `recordStage()` with `{ stage, enteredAt }`
- **THEN** the bundle SHALL contain a stage entry with the given `stage` name and `enteredAt` value

#### Scenario: stage exit recorded on same entry
- **WHEN** the same stage handler calls `recordStage()` again with `{ exitedAt, outcome }` for the same stage name
- **THEN** the existing stage entry SHALL be updated with `exitedAt` and `outcome`
- **AND** no duplicate stage entry SHALL be created

#### Scenario: multiple stages recorded in order
- **WHEN** stages `planning` → `review` → `pre-merge` each call `recordStage()`
- **THEN** the bundle `stages` array SHALL contain entries for all three stages in insertion order

---

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

#### Scenario: review verdict recorded
- **WHEN** the review stage parses a verdict JSON and calls `recordReview()`
- **THEN** the bundle `reviews` array SHALL contain a `ReviewRecord` with `round`, `sha`, `verdict`, and `findingCounts`

#### Scenario: multiple review rounds accumulate
- **WHEN** two review rounds complete
- **THEN** the bundle `reviews` array SHALL contain two entries with `round: 1` and `round: 2` respectively

---

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
The pipeline CLI SHALL support a `--summary <issueNumber>` flag. When this flag is present, the CLI SHALL read the bundle for the given issue, print a human-readable summary (at minimum: run identity, per-stage outcome table, review verdict list, override list, and final state), and exit without entering the dispatch loop.

#### Scenario: --summary prints identity and stages
- **WHEN** `pipeline --summary 147` is invoked
- **THEN** the output SHALL include the `runId`, `issue`, `branch`, each stage name and its `outcome`, and `finalState`

#### Scenario: --summary exits zero when bundle exists
- **WHEN** `pipeline --summary <N>` is invoked and a bundle exists for issue N
- **THEN** the process SHALL exit with code 0

#### Scenario: --summary exits non-zero when no bundle
- **WHEN** `pipeline --summary <N>` is invoked and no bundle exists for issue N
- **THEN** the process SHALL exit with a non-zero code and print an error message

---

### Requirement: PR or issue receives a single path-notification comment at finalization
After `finalizeBundle()` succeeds, the pipeline SHALL post a comment on the PR (or issue if no PR is open) recording the local file path of the bundle. The comment SHALL be posted at most once per run: if the bundle already records a notification, the comment SHALL be skipped on subsequent finalization calls.

#### Scenario: path comment posted at finalization
- **WHEN** `finalizeBundle()` is called and no prior notification is recorded in the bundle
- **THEN** the orchestrator SHALL post a comment containing the bundle file path
- **AND** the bundle SHALL record a `notifiedAt` timestamp after posting

#### Scenario: path comment not re-posted
- **WHEN** `finalizeBundle()` is called and `notifiedAt` is already set in the bundle
- **THEN** the orchestrator SHALL NOT post another path comment

---

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

