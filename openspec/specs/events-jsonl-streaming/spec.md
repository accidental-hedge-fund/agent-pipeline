# events-jsonl-streaming Specification

## Purpose
TBD - created by archiving change desktop-run-artifact-contract. Update Purpose after archive.

## Requirements

### Requirement: events.jsonl is an append-only atomic event log
The run directory SHALL contain `events.jsonl` — a log file where each line is a complete, newline-terminated JSON object. Each write SHALL use O_APPEND semantics so that concurrent or sequential writers do not corrupt prior entries. Lines SHALL be written atomically as a single OS write syscall. A reader SHALL tolerate: (1) a missing file — treated as an empty log; (2) a corrupt or partial final line — skipped silently; (3) unknown fields in any record — preserved in the parsed output unchanged.

#### Scenario: events.jsonl created at run directory init
- **WHEN** `initRunDir(...)` is called
- **THEN** `events.jsonl` SHALL exist in the run directory (empty or with a `run_start` event)

#### Scenario: appended line is valid JSON with required fields
- **WHEN** `appendEvent(event)` is called with a valid event object
- **THEN** a newline-terminated JSON line SHALL be appended to `events.jsonl`
- **AND** the line SHALL parse as JSON and contain at minimum `schema_version`, `type`, and `at` fields

#### Scenario: reader tolerates a corrupt or partial tail line
- **WHEN** `events.jsonl` contains a partial or unparseable final line (e.g., from a mid-write crash)
- **THEN** `readEvents()` SHALL return all fully parseable prior lines
- **AND** SHALL NOT throw an error or return the corrupt line in the result

#### Scenario: reader returns empty array for missing file
- **WHEN** `events.jsonl` does not exist
- **THEN** `readEvents()` SHALL return an empty array without throwing

#### Scenario: reader preserves unknown fields
- **WHEN** an event record in `events.jsonl` contains fields not known to the current reader version
- **THEN** `readEvents()` SHALL include those fields in the returned object, unchanged

---

### Requirement: Stage lifecycle events are recorded in events.jsonl
The orchestrator SHALL append a `stage_start` event when a stage handler is entered and a `stage_complete` event when a stage handler exits. Both event types SHALL contain at minimum: `schema_version` (integer), `type` (string: `"stage_start"` or `"stage_complete"`), `at` (ISO 8601 UTC string), and `stage` (stage name string). `stage_complete` SHALL additionally contain `outcome` (one of `"advanced"`, `"blocked"`, `"skipped"`, or `"error"`).

#### Scenario: stage_start event appended on stage entry
- **WHEN** a stage handler is entered
- **THEN** a `stage_start` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `schema_version`, `type: "stage_start"`, `at`, and `stage`

#### Scenario: stage_complete event appended on stage exit
- **WHEN** a stage handler exits
- **THEN** a `stage_complete` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `schema_version`, `type: "stage_complete"`, `at`, `stage`, and `outcome`

#### Scenario: terminal ready-to-deploy stage emits lifecycle events
- **WHEN** the run reaches the terminal `ready-to-deploy` stage (handled outside the common dispatch block)
- **THEN** a `stage_start` and a `stage_complete` event SHALL still be appended for it, so the timeline is complete through the terminal stage

#### Scenario: Pipeline Desk renders stage timeline from events.jsonl without prose
- **WHEN** a consumer reads `events.jsonl` and filters for `stage_start` and `stage_complete` events
- **THEN** it SHALL be able to reconstruct the full ordered stage timeline (entry times, exit times, outcomes)
- **AND** no terminal output or human-readable prose SHALL be required

---

### Requirement: Key run lifecycle events are recorded in events.jsonl
The orchestrator SHALL append a `run_start` event immediately after the run directory is created and a `run_complete` event at finalization. Additional events SHALL be appended for significant state changes: `pr_created` (PR opened), `pr_updated` (PR updated), `worktree_created`, `worktree_removed`, `review_verdict` (per review round), `blocker_set`, and `blocker_cleared`. Each event type SHALL carry its type-specific fields in addition to the base `schema_version`, `type`, and `at` fields.

The `review_verdict` event SHALL additionally carry a `findings` array — one record per finding enumerated by the round — and the reviewer identity for the round (`reviewer_harness`, `reviewer_model`, `self_review`). Each finding record SHALL contain `key` (the stable `findingKey`), `severity`, `title`, `body`, `confidence`, and `recommendation`, and SHALL contain `file`, `line_start`, `line_end`, `category`, and `blocking` when the finding carries them. Each finding record SHALL also carry `effective_blocking` (boolean, computed from `partitionFindings` after the active policy is applied) and `payload_fingerprint` (`findingPayloadFingerprint(finding)` — disambiguates same-key distinct findings within a round). The `findings` array and reviewer-identity fields are additive optional fields, so `schema_version` SHALL remain `1`; their text fields SHALL be screened by the write-time injection denylist and secret redaction before the line is appended.

#### Scenario: run_start event appended at init
- **WHEN** `initRunDir(...)` completes successfully
- **THEN** a `run_start` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `issue`, `repo`, and `run_id` in addition to the base fields

#### Scenario: run_complete event appended at finalization
- **WHEN** `finalizeRun(...)` is called
- **THEN** a `run_complete` event SHALL be appended to `events.jsonl` before `summary.json` is written
- **AND** the event SHALL contain `final_state` and `elapsed_ms`

#### Scenario: review_verdict event contains structured data
- **WHEN** a review round completes and a verdict is parsed
- **THEN** a `review_verdict` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain `round` (integer), `sha` (string), `verdict` (string), and `finding_counts` (object)

#### Scenario: review_verdict event carries per-finding records
- **WHEN** a review round enumerates one or more findings
- **THEN** the `review_verdict` event SHALL contain a `findings` array with one record per finding
- **AND** each record SHALL contain `key`, `severity`, `title`, `body`, `confidence`, and `recommendation`
- **AND** `file`, `line_start`, `line_end`, `category`, and `blocking` SHALL be present when the finding carries them

#### Scenario: review_verdict event carries reviewer identity
- **WHEN** a review round completes
- **THEN** the `review_verdict` event SHALL contain `reviewer_harness` (the harness that actually reviewed), `reviewer_model`, and `self_review` (boolean)

#### Scenario: review_verdict with zero findings carries an empty array
- **WHEN** a review round produces a verdict with no enumerated findings
- **THEN** the `review_verdict` event SHALL contain `findings: []`
- **AND** SHALL still contain `round`, `sha`, `verdict`, and `finding_counts`

#### Scenario: blocker_set and blocker_cleared events enable blocking state reconstruction
- **WHEN** the pipeline sets a blocking condition
- **THEN** a `blocker_set` event SHALL be appended with a `reason` string
- **WHEN** the blocking condition is cleared
- **THEN** a `blocker_cleared` event SHALL be appended

### Requirement: --json-events flag streams lifecycle events to stdout
When the pipeline CLI is invoked with `--json-events`, each event appended to `events.jsonl` SHALL also be written to stdout as the same JSON line (identical content). Human-readable pipeline output SHALL continue to be written to `terminal.log` (and stderr where applicable). The `--json-events` flag SHALL NOT suppress, redirect, or modify the content written to `terminal.log`.

#### Scenario: event appears on stdout in --json-events mode
- **WHEN** the pipeline runs with `--json-events` and a stage is entered
- **THEN** the `stage_start` JSON line SHALL appear on stdout at the same time it is appended to `events.jsonl`

#### Scenario: stage-owned lifecycle events also stream to stdout
- **WHEN** the pipeline runs with `--json-events` and a stage handler emits a lifecycle event from inside the handler (`worktree_created`, `pr_created`/`pr_updated`, or `review_verdict`)
- **THEN** that event's JSON line SHALL also appear on stdout — not only `events.jsonl` — so a desktop consumer reconstructing the run from stdout does not miss it

#### Scenario: terminal.log unaffected by --json-events
- **WHEN** the pipeline runs with `--json-events`
- **THEN** `terminal.log` SHALL contain the full human-readable pipeline output
- **AND** the content of `terminal.log` SHALL be identical to what it would contain without `--json-events`

#### Scenario: --json-events mode is backward-compatible for terminal users
- **WHEN** a terminal user runs the pipeline without `--json-events`
- **THEN** no JSON lines SHALL appear on stdout
- **AND** pipeline behavior SHALL be identical to before this change

### Requirement: human_intervention is a recognized event type in events.jsonl
The `events.jsonl` format SHALL recognize `"human_intervention"` as a valid event `type` alongside the existing `stage_start`, `stage_complete`, `run_start`, `run_complete`, `pr_created`, `pr_updated`, `worktree_created`, `worktree_removed`, `review_verdict`, `blocker_set`, and `blocker_cleared` types. Readers SHALL NOT reject or skip `human_intervention` events when iterating the log. The `human_intervention` event type is additive and does not change `schema_version`.

#### Scenario: reader includes human_intervention events when iterating
- **WHEN** `readEvents()` is called on an `events.jsonl` containing a mix of `stage_complete` and `human_intervention` events
- **THEN** both event types SHALL be present in the returned array
- **AND** the reader SHALL NOT skip or drop `human_intervention` lines

#### Scenario: human_intervention events do not affect stage timeline reconstruction
- **WHEN** a consumer filters `events.jsonl` for `stage_start` and `stage_complete` events to reconstruct the stage timeline
- **THEN** `human_intervention` events SHALL be excluded by the type filter
- **AND** the stage timeline SHALL be identical to a log without `human_intervention` events

### Requirement: stage_accounting events are recorded in events.jsonl

The orchestrator and harness invocation paths SHALL append a `stage_accounting`
event whenever a stage accounting record is produced. The event SHALL contain
the base event fields `schema_version`, `type: "stage_accounting"`, and `at`,
plus the complete stage accounting record fields defined by the
`stage-cost-accounting` capability. The event type is additive and SHALL NOT
change the meaning of existing `stage_start`, `stage_complete`, `run_start`, or
`run_complete` events.

#### Scenario: stage_accounting event appended after harness invocation

- **WHEN** a stage harness invocation returns and a stage accounting record is
  produced
- **THEN** a `stage_accounting` event SHALL be appended to `events.jsonl`
- **AND** the event SHALL contain the stage, harness, model slot/model
  identifier, duration, outcome, and cost source for that invocation

#### Scenario: stage_accounting streams in json-events mode

- **WHEN** the pipeline runs with `--json-events`
- **AND** a `stage_accounting` event is appended to `events.jsonl`
- **THEN** the same JSON line SHALL also be written to stdout

#### Scenario: stage lifecycle reconstruction ignores accounting events

- **WHEN** a consumer reconstructs the stage timeline by filtering for
  `stage_start` and `stage_complete` events
- **THEN** `stage_accounting` events SHALL be excluded by the type filter
- **AND** the reconstructed timeline SHALL be identical to a log without
  `stage_accounting` events

### Requirement: harness_timeout is recorded in events.jsonl when a harness wall-clock cap fires

The harness invocation path SHALL append a `harness_timeout` event to `events.jsonl` at the moment a `runCapped` wall-clock cap fires — before, and independent of, the `runCapped` promise resolving — so an external supervisor tailing the event stream can detect a wedged harness without process introspection. The event SHALL contain at minimum `schema_version` (integer), `type: "harness_timeout"`, `at` (ISO 8601 UTC string), a stage/label identifier for the timed-out invocation, and `timeout_sec` (the configured cap). Recording SHALL be best-effort: when the invocation carries no run-store context (a bare `runCapped` caller), no event is appended and behavior is unchanged, and an append failure SHALL NOT change the harness outcome. The event type is additive and SHALL NOT change `schema_version`, which remains `1`; `readEvents()` SHALL NOT reject or skip `harness_timeout` events.

#### Scenario: harness_timeout appended at cap-fire time

- **WHEN** a `runCapped` invocation that carries a run-store context exceeds its wall-clock cap
- **THEN** a `harness_timeout` event SHALL be appended to `events.jsonl` at the moment the cap fires
- **AND** the event SHALL contain `schema_version`, `type: "harness_timeout"`, `at`, the stage/label of the invocation, and `timeout_sec`
- **AND** it SHALL be appended before — and independent of — the `runCapped` promise resolving

#### Scenario: no harness_timeout on a normal pre-cap exit

- **WHEN** a harness invocation exits normally before its wall-clock cap fires
- **THEN** no `harness_timeout` event SHALL be appended to `events.jsonl`

#### Scenario: bare runCapped caller with no run-store context records nothing

- **WHEN** a `runCapped` caller passes no run-store context and its cap fires
- **THEN** no `harness_timeout` event SHALL be appended
- **AND** the caller's behavior SHALL be identical to before this change

#### Scenario: reader includes harness_timeout and stage-timeline filters exclude it

- **WHEN** `readEvents()` is called on an `events.jsonl` containing `harness_timeout` events mixed with `stage_start`/`stage_complete` events
- **THEN** the `harness_timeout` events SHALL be present in the returned array
- **AND** a consumer filtering for `stage_start`/`stage_complete` to reconstruct the stage timeline SHALL exclude `harness_timeout` events

#### Scenario: harness_timeout streams in json-events mode

- **WHEN** the pipeline runs with `--json-events` and a `harness_timeout` event is appended to `events.jsonl`
- **THEN** the same JSON line SHALL also be written to stdout

### Requirement: Delta-round governance event types SHALL be recognized in events.jsonl

`events.jsonl` SHALL recognize four additional event types, each carrying the run schema version and an ISO-8601 `at` timestamp like every other event:

- `delta_round` — fields: `round` (1-based number of this delta round for the item) and `cap` (the configured `review_policy.max_delta_rounds`).
- `delta_round_ceiling` — fields: `observed` (the durable delta-round count), `cap`, and `ceiling_action` (`park` or `demote_and_advance`).
- `delta_churn_suspected` — fields: `round`, and `axes` (each with the axis surface, the prior maximum confidence, and the new confidence).
- `settled_alternative_reinstated` — fields: `finding_key`, `surface`, `settled_finding_key`, `settling_round`, and `matched_alternative`.

These events SHALL be appended through the same append-only atomic write path as existing events, and SHALL be streamed by `--json-events` like any other lifecycle event.

#### Scenario: Delta round and ceiling events are appended

- **WHEN** a pre-merge delta round runs and a later entry reaches the configured cap
- **THEN** `events.jsonl` SHALL contain a `delta_round` record carrying `round` and `cap`
- **AND** SHALL contain a `delta_round_ceiling` record carrying `observed`, `cap`, and `ceiling_action`

#### Scenario: Churn and reinstatement events are appended

- **WHEN** a delta round is flagged as suspected churn and a finding is demoted for reinstating a settled rejected alternative
- **THEN** `events.jsonl` SHALL contain a `delta_churn_suspected` record naming the round and the involved axes with their prior and new confidences
- **AND** SHALL contain a `settled_alternative_reinstated` record naming the demoted key, surface, settled key, settling round, and matched alternative

#### Scenario: New event types stream over --json-events

- **WHEN** the run is invoked with `--json-events` and any of the four event types is emitted
- **THEN** the event SHALL be streamed to stdout in the same envelope as existing lifecycle events

### Requirement: correction_event is a recognized event type in events.jsonl

The `events.jsonl` format SHALL recognize `"correction_event"` as a valid event `type`
alongside the existing lifecycle, `review_verdict`, `blocker_set`/`blocker_cleared`,
`human_intervention`, `stage_accounting`, and `papercut` types. A `correction_event` SHALL be
appended through the same `appendEvent` chokepoint as every other event, so it inherits
`--json-events` stdout streaming byte-for-byte. Each `correction_event` line SHALL carry the
base `schema_version`, `type`, and `at` fields plus the `correction_event` contract
(`correction_id`, `correction_key`, `source_kind`, `failure_class`, `actor_kind`, `issue`,
`repo`, `run_id`, `stage`, `reviewed_sha`, `head_sha`, `evidence_ref`, `correction`,
`reusable`, and optional `proposed_control`). Readers SHALL NOT reject or skip `correction_event`
lines when iterating the log, and stage-timeline reconstruction SHALL exclude them by type
filter. The `correction_event` type is additive and does not change `schema_version`.

#### Scenario: reader includes correction_event lines when iterating

- **WHEN** `readEvents()` is called on an `events.jsonl` containing a mix of `stage_complete` and `correction_event` events
- **THEN** every appended `correction_event` line SHALL be returned to the caller
- **AND** the reader SHALL NOT skip or drop `correction_event` lines

#### Scenario: correction_event streams under --json-events

- **WHEN** a `correction_event` is appended while `--json-events` is active
- **THEN** the identical JSON line SHALL be written to stdout, as for every other event type

#### Scenario: correction_event does not affect stage timeline reconstruction

- **WHEN** a stage timeline is reconstructed from an `events.jsonl` containing `correction_event` lines
- **THEN** `correction_event` lines SHALL be excluded by the type filter
- **AND** the stage timeline SHALL be identical to a log without `correction_event` lines

### Requirement: appendEvent durable-delivery failure SHALL update write-health and return false

`appendEvent` SHALL return `false`, log a non-fatal warning, and update the run's write-health
record as specified by the `run-store-write-health` capability when it cannot durably deliver an
event line — the local `events.jsonl` write fails and no successful exclusive-sink delivery or
exclusive-mode local fallback remains. `appendEvent` SHALL NOT throw or reject solely because of
that I/O failure. Successful durable delivery SHALL return `true` and SHALL NOT increment the
failure count.

#### Scenario: appendEvent returns false and records write-health on local I/O failure

- **WHEN** the local append to `events.jsonl` throws and no sink provides durable delivery
- **THEN** `appendEvent` SHALL return `false`
- **AND** write-health for the run SHALL reflect the failure
- **AND** `appendEvent` SHALL NOT throw

#### Scenario: Successful append returns true

- **WHEN** the local `events.jsonl` append succeeds (and sink delivery succeeds when required for
  exclusive mode)
- **THEN** `appendEvent` SHALL return `true`
- **AND** write-health failure count SHALL NOT increase

### Requirement: Readers and restart paths SHALL tolerate partial writes without misclassifying health

`readEvents` SHALL continue to tolerate a missing file (empty array), a corrupt or partial final
line (skip silently), and unknown fields (preserve). After a mid-write crash or process restart, a
consumer SHALL be able to read all complete prior lines. A write-health record that indicates
failures, or an unfinalized run whose event stream ends without `run_complete` after a recorded
write failure, SHALL be observable to status/summary consumers as degraded event-stream health and
SHALL NOT be treated as a successful complete audit trail.

#### Scenario: Partial tail line is skipped and prior events remain readable

- **WHEN** `events.jsonl` ends with a partial or unparseable final line after a mid-write failure
- **THEN** `readEvents()` SHALL return all fully parseable prior lines
- **AND** SHALL NOT throw
- **AND** SHALL NOT include the corrupt tail line

#### Scenario: Restart after append failure exposes write-health

- **WHEN** a run process records an append failure in write-health and then exits
- **AND** a subsequent process reads the same run directory
- **THEN** write-health SHALL still report the failure
- **AND** `readEvents()` SHALL return whatever complete lines were flushed before the failure

### Requirement: Optional fsync after event append SHALL not change the non-fatal contract

The engine SHALL treat optional post-append fsync (or equivalent durability flush) failure for
`events.jsonl` as a durable-delivery failure for that append: return `false`, update write-health,
and do not throw. When fsync is not enabled, the engine SHALL retain O_APPEND single-line write
semantics and SHALL document any residual durability gap relative to the durable loop store's
temp+fsync+rename document writes.

#### Scenario: fsync failure is non-fatal and visible

- **WHEN** optional post-append fsync is enabled and fsync fails after a write
- **THEN** `appendEvent` SHALL return `false`
- **AND** write-health SHALL record the failure
- **AND** `appendEvent` SHALL NOT throw

#### Scenario: Without fsync the non-fatal append contract remains

- **WHEN** optional fsync is not enabled
- **THEN** successful `appendFile` of a complete newline-terminated JSON line SHALL still return
  `true`
- **AND** I/O failures SHALL remain non-fatal with write-health recording

### Requirement: Planning-leverage family events SHALL be appendable to events.jsonl via appendEvent

The orchestrator and stage paths SHALL be able to append planning-leverage family events to the run's `events.jsonl` through the same `appendEvent` path used by other run events. Supported additive `type` values SHALL include at least:

- `planning_leverage_phase` — phase boundary start/end with phase, timestamps, planning_depth, risk_class, and duration fields defined by planning-leverage-telemetry
- `assumption_lineage` — create/update of an assumption or open question per assumption-lineage
- `material_rework` — materiality classification for a correction span or fix round per material-rework-telemetry
- `planning_leverage_snapshot` — optional rolled-up raw + derived checkpoint for a run

Each event SHALL carry base fields `schema_version` (integer, remains `1` for the stream), `type`, and `at` (ISO 8601), plus the type-specific payload fields. Adding these types SHALL NOT change the meaning of existing `stage_start`, `stage_complete`, `run_start`, `run_complete`, or `stage_accounting` events. Stage-timeline reconstruction that filters only lifecycle types SHALL continue to exclude these additive types. `readEvents()` SHALL NOT reject or skip these types when present.

#### Scenario: phase boundary appends planning_leverage_phase

- **WHEN** a planning phase starts or ends for a run with an active run store
- **THEN** a `planning_leverage_phase` event SHALL be appendable to `events.jsonl`
- **AND** the event SHALL include `schema_version`, `type: "planning_leverage_phase"`, `at`, `phase`, and `boundary` (`start` or `end`)

#### Scenario: assumption update appends assumption_lineage

- **WHEN** an assumption status is recorded or updated for a run
- **THEN** an `assumption_lineage` event SHALL be appendable to `events.jsonl`
- **AND** the event SHALL include a stable `assumption_id` and `status`

#### Scenario: fix-round materiality appends material_rework

- **WHEN** a fix round completes and materiality is classified
- **THEN** a `material_rework` event SHALL be appendable to `events.jsonl`
- **AND** the event SHALL include `materiality` and `material_criteria`

#### Scenario: stage timeline filters still ignore leverage events

- **WHEN** a consumer reconstructs the stage timeline by filtering for `stage_start` and `stage_complete`
- **THEN** `planning_leverage_phase`, `assumption_lineage`, `material_rework`, and `planning_leverage_snapshot` events SHALL be excluded by that filter
- **AND** the reconstructed lifecycle timeline SHALL match a log without those events

#### Scenario: stream schema_version remains 1

- **WHEN** any planning-leverage family event is appended
- **THEN** the event's base `schema_version` SHALL be `1`
- **AND** existing event types SHALL keep their prior field contracts

---

### Requirement: Planning-leverage family events SHALL receive the same sink delivery and redaction as other appendEvent records

When an event sink is active, each planning-leverage family event that is appended SHALL be delivered to the sink as the identical newline-terminated JSON line written to `events.jsonl` (subject to the configured sink mode). The payload SHALL be screened by the write-time injection denylist and secret redaction before delivery. Sink failure handling SHALL match the existing `appendEvent` non-fatal contract for other additive event types.

#### Scenario: sink receives material_rework line byte-identical to events.jsonl

- **WHEN** an event sink is active in additive mode
- **AND** a `material_rework` event is appended
- **THEN** the sink SHALL receive the same JSON line written to `events.jsonl` for that event

#### Scenario: secret redaction applies before append

- **WHEN** an `assumption_lineage` statement would contain a recognized secret pattern
- **THEN** the line written to `events.jsonl` (and delivered to any sink) SHALL contain the redacted form only

### Requirement: run_complete after non-terminal iteration-budget exhaustion SHALL carry a typed incomplete marker

The orchestrator SHALL still append a `run_complete` event when an advance invocation ends because `MAX_ITERATIONS` is exhausted at a non-terminal stage, so `pipeline logs --events --follow` can observe end-of-run. That `run_complete` event SHALL NOT have a terminal-success shape: it SHALL include an additive typed incomplete marker `stop_reason` whose value is `iteration-budget-exhausted`. `schema_version` SHALL remain `1`. The event SHALL still contain `final_state` (the non-terminal **pre-park** stage, never `blocked` solely because this path later applied a block) and `elapsed_ms`. The orchestrator SHALL write this event **before** setting a non-zero `process.exitCode`. It SHALL NOT call `process.exit()` for this path.

A `run_complete` for a successful `ready-to-deploy` finalize, a `needs-human` park, an in-loop `waiting`/`blocked` stop, or an in-loop auto-loop budget-exhaustion park SHALL NOT receive `stop_reason: "iteration-budget-exhausted"` solely because the run used many iterations.

#### Scenario: exhausted pre-merge run_complete is marked incomplete

- **WHEN** an advance invocation exhausts `MAX_ITERATIONS` at `pre-merge` and `finalizeRun` writes `run_complete`
- **THEN** that event SHALL contain `final_state` of `pre-merge`
- **AND** SHALL contain `stop_reason` equal to `iteration-budget-exhausted`
- **AND** `schema_version` SHALL remain `1`
- **AND** `final_state` SHALL NOT equal `blocked` solely because the path parked with `ci-exhausted`

#### Scenario: successful ready-to-deploy run_complete is not marked iteration-exhausted

- **WHEN** an advance invocation reaches `ready-to-deploy` and terminal finalize runs (in-loop or deferred)
- **THEN** the `run_complete` event SHALL contain `final_state` of `ready-to-deploy`
- **AND** SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`

#### Scenario: in-loop waiting stop does not mark run_complete as iteration-exhausted

- **WHEN** the loop breaks on a `waiting` outcome before the iteration cap
- **AND** `finalizeRun` writes `run_complete`
- **THEN** that event SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`

#### Scenario: waiting break on the last slot does not mark run_complete as iteration-exhausted

- **WHEN** the loop is on the last `MAX_ITERATIONS` slot and breaks on `waiting`
- **AND** `finalizeRun` writes `run_complete`
- **THEN** that event SHALL NOT contain `stop_reason` equal to `iteration-budget-exhausted`

### Requirement: Admission and nested-child events SHALL stamp logical_operation_id

`run_start` and other admission-time events for numeric drive, `single`, `loop`, `train`, `merge`, merge queue, and `ship` SHALL include `logical_operation_id` as an additive field. Nested child events SHALL carry the parent identity. `schema_version` SHALL remain `1`. Readers SHALL preserve the field on unknown-field pass-through. Retries and fresh-process resumes that present a valid resume binding SHALL reuse the original identity on the new physical run's events.

#### Scenario: run_start carries logical_operation_id

- **WHEN** `initRunDir` completes for a new public admission
- **THEN** the `run_start` event SHALL contain `logical_operation_id` in addition to `run_id`
- **AND** `schema_version` SHALL remain `1`

#### Scenario: Fresh-process resume does not mint a second identity on events

- **WHEN** a fresh process resumes the same logical operation through a valid resume binding
- **THEN** events on the new physical run SHALL carry the original `logical_operation_id`
- **AND** SHALL NOT introduce a different logical identity for the same admission

#### Scenario: Readers preserve the additive field

- **WHEN** an older reader parses an event that includes `logical_operation_id`
- **THEN** `readEvents()` SHALL include that field unchanged
