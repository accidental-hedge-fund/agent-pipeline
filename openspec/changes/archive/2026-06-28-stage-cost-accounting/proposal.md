## Why

Agent pipeline runs already produce lifecycle evidence, but they do not expose
which stages, harnesses, model slots, and outcomes consume the most budget. This
keeps the pipeline blind to variable production cost and makes future
ROI-aware routing decisions guesswork instead of measurement.

## What Changes

- Add a stage-level accounting record contract for harness/subprocess work,
  including stage, harness, model slot or model identifier, timing, command or
  subprocess counts, outcome, blocker category, and cost source.
- Record actual token/cost usage when it is available from safe provider output
  or local usage summaries, and record missing usage explicitly as
  `estimated` or `unknown` rather than zero.
- Persist accounting records through existing run artifacts: `events.jsonl`
  during execution and `summary.json`/legacy `evidence.json` at finalization.
- Extend the factory scoreboard so cost can be summarized by stage, harness,
  model slot/model identifier, outcome, and issue.
- Preserve current routing and state-machine behavior; this change only records
  inputs that future routing can use.
- Prevent raw usage-log content, prompts, responses, transcripts, and secrets
  from being written to public issue comments or machine-readable artifacts.

## Capabilities

### New Capabilities

- `stage-cost-accounting`: Defines stage-level accounting records, cost-source
  classification, estimation semantics, and privacy constraints for usage-derived
  data.

### Modified Capabilities

- `events-jsonl-streaming`: Adds accounting events that are appended during
  stage/harness execution without changing existing lifecycle events.
- `evidence-bundle`: Adds finalized accounting records and rollups to
  `summary.json` and legacy `evidence.json`.
- `factory-scoreboard`: Extends cost reporting so the scoreboard can aggregate
  by stage, harness, model slot/model identifier, outcome, and issue.

## Impact

- `core/scripts/` run-artifact and event helpers — add accounting event and
  summary record write paths using existing non-fatal artifact conventions.
- `core/scripts/stages/` and harness invocation paths — capture stage/harness
  timing, model slot/model identifier, subprocess counts, outcomes, blocker
  category, and sanitized usage metrics where available.
- `core/scripts/scoreboard*` — aggregate accounting records into human-readable
  and JSON cost reports with explicit diagnostics for unknown costs.
- `core/test/` — add unit coverage for accounting record shape, actual vs
  estimated vs unknown costs, sanitized usage ingestion, summary rollup, and
  scoreboard aggregation.
- No changes to `STAGES`, label transitions, review routing, merge behavior, or
  default model selection.

## Acceptance Criteria

- [ ] A pipeline run that invokes at least one harness writes an accounting
  record containing stage, harness, model slot/model identifier, start/end or
  duration, subprocess/command count, outcome, and cost source to the run's
  machine-readable artifacts.
- [ ] When actual token or cost data is unavailable, the persisted accounting
  record marks the cost as `estimated` or `unknown`; no missing actual cost is
  serialized as numeric zero.
- [ ] `summary.json` and the legacy issue-scoped `evidence.json` include the
  same accounting records or rollups after finalization.
- [ ] `pipeline scoreboard --json` exposes cost totals grouped by stage,
  harness, model slot/model identifier, outcome, and issue for included runs.
- [ ] Human-readable scoreboard output includes a cost/accounting section that
  distinguishes actual, estimated, and unknown cost data.
- [ ] Accounting data is not used to change stage routing, label transitions,
  review selection, or merge behavior in this change.
- [ ] Usage-log ingestion persists only sanitized numeric/accounting metadata;
  raw prompts, responses, transcripts, provider request payloads, and secret
  values do not appear in issue comments, `events.jsonl`, `summary.json`, or
  legacy `evidence.json`.
