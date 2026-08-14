## ADDED Requirements

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
