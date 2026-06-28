## Context

The pipeline already writes run-scoped artifacts under `.agent-pipeline/runs/`:
`events.jsonl` for append-only lifecycle events, `summary.json` for finalized
evidence, and legacy `<stateDir>/<issue>/evidence.json` for compatibility. The
factory scoreboard scans those artifacts and already has an early harness-call
cost metric, but it cannot explain cost at the stage/model/outcome level because
the run artifacts do not contain normalized accounting records.

This change spans stage execution, harness invocation, usage ingestion, evidence
finalization, and scoreboard aggregation. It must remain observational: the
recorded accounting data can feed future routing work, but this issue must not
change the state machine, model selection, review ordering, or label
transitions.

## Goals / Non-Goals

**Goals:**

- Capture per-stage accounting records for harness and subprocess work using
  existing run artifacts.
- Represent actual, estimated, and unknown costs explicitly, without treating
  missing actual usage as zero.
- Preserve enough dimensions for future ROI-aware routing: issue, stage,
  harness, model slot/model identifier, outcome, blocker category, timing, and
  command/subprocess count.
- Keep raw usage logs, prompts, responses, transcripts, provider payloads, and
  secrets out of public comments and machine-readable artifacts.
- Extend the scoreboard so cost can be reported by stage, harness, model slot,
  outcome, and issue.

**Non-Goals:**

- Changing the pipeline stage sequence, routing policy, review harness
  selection, model-slot defaults, or merge behavior.
- Building an optimizer or ROI-aware router in this issue.
- Reconstructing historical costs for older run artifacts that lack accounting
  records.
- Guaranteeing provider-grade billing precision for every harness. Honest
  classification is more important than false precision.

## Decisions

### Decision 1: Use a normalized `stage_accounting` event

Each accounting observation is appended to `events.jsonl` as a
`stage_accounting` event with a stable schema: `schema_version`, `type`,
`at`, `run_id`, `issue`, `stage`, `harness`, `model_slot`, `model`,
`started_at`, `ended_at`, `duration_ms`, `command_count`, `subprocess_count`,
`outcome`, `blocker_kind`, `cost_source`, `cost_usd`, and optional sanitized
`usage` token counters.

**Rationale:** The event log already exists, is append-only, supports crash
recovery, and streams under `--json-events`. Adding an event type avoids a new
sidecar artifact and keeps desktop/status consumers on the same read path.

**Alternative considered:** Write a separate `accounting.jsonl` file. Rejected
because it would add another synchronization surface and would not stream through
the existing JSON-events contract.

### Decision 2: Finalize accounting into `summary.json.accounting`

At finalization, the evidence bundle includes `accounting.records[]` copied from
the run's `stage_accounting` events in chronological order, plus small run-level
totals: actual USD, estimated USD, unknown record count, and record count. The
legacy `evidence.json` receives the same finalized content because it mirrors
`summary.json`.

**Rationale:** `events.jsonl` is best for incremental observation; `summary.json`
is best for finalized reports and legacy consumers. Keeping the same normalized
records in the summary makes scoreboard aggregation deterministic even when it
does not need to replay every event.

### Decision 3: Cost source is explicit and tri-state

`cost_source` is one of `actual`, `estimated`, or `unknown`.

- `actual`: persisted only when sanitized provider output or local usage summary
  exposes numeric cost or token/cost values for the invocation.
- `estimated`: persisted only when the engine applies an explicit deterministic
  estimator, such as configured per-model/per-harness rates or a user-supplied
  report estimate.
- `unknown`: persisted when neither actual nor explicit estimate is available.

`cost_usd` is numeric only for `actual` or `estimated` records and is `null` for
`unknown`. Missing usage is never serialized as `0`.

**Rationale:** Zero means free, which is different from unobserved. The tri-state
source lets reports separate known spend from guessed spend and from blind spots.

### Decision 4: Usage-log ingestion is allowlist-only

Usage ingestion extracts only allowlisted numeric and identifier fields needed
for accounting: token counts, cost, model identifier, model slot, harness name,
and timestamps/durations. It does not persist raw log lines, request payloads,
prompts, completions, transcripts, file paths to usage logs, or provider request
bodies. All persisted string fields still pass through the existing artifact
redaction and injection-denylist path.

**Rationale:** Local usage logs can contain sensitive prompts or provider
payloads. A denylist is not enough for this source; the safer contract is to
derive accounting facts and discard the raw record.

### Decision 5: Scoreboard aggregates records, not routing decisions

The scoreboard reads accounting records from `summary.json.accounting.records`
when available and falls back to `stage_accounting` events when summary data is
absent or corrupt. It emits grouped totals by issue, stage, harness, model
slot/model identifier, and outcome. Groups carry actual totals, estimated totals,
unknown counts, duration totals, and invocation counts.

**Rationale:** The scoreboard is already the factory-level reporting surface.
Adding grouped accounting there produces immediate visibility while keeping the
advance loop independent from cost data.

## Risks / Trade-offs

- [Risk] Some harnesses may not expose actual usage in a stable local format. →
  Mitigation: persist `unknown` with a diagnostic/report count instead of
  inventing a zero or silently omitting the record.
- [Risk] Usage logs may contain sensitive content adjacent to numeric usage
  fields. → Mitigation: use allowlist extraction and persist only derived fields,
  then pass records through existing artifact redaction before writing.
- [Risk] Accounting records may duplicate information already present in command
  or prompt records. → Mitigation: keep accounting records compact and focused on
  cost/timing dimensions; existing prompt/command excerpts remain unchanged.
- [Risk] Summary and event data could disagree after a crash. → Mitigation:
  scoreboard prefers finalized summary data but falls back to events for partial
  runs, consistent with existing artifact tolerance.
- [Risk] Future routing code could accidentally start reading accounting data in
  this change. → Mitigation: implementation tasks and tests assert no changes to
  stage ordering, label transitions, or harness-selection behavior.
