## 1. Accounting Model and Artifact Helpers

- [x] 1.1 Inspect current stage, harness, command-recording, event, evidence, and scoreboard call sites to identify the narrowest capture points.
- [x] 1.2 Add a `StageAccountingRecord` type with required fields for issue, run, stage, harness, model slot/model identifier, timing, counts, outcome, blocker kind, cost source, cost USD, and optional sanitized usage counters.
- [x] 1.3 Add allowlist-based usage extraction helpers that keep only numeric usage/cost fields and approved identifiers, then pass persisted strings through existing artifact redaction.
- [x] 1.4 Add a non-fatal helper for appending `stage_accounting` events to `events.jsonl`, preserving `--json-events` streaming behavior.

## 2. Invocation Capture

- [x] 2.1 Wrap harness invocation paths so each completed invocation records start/end or duration, harness, stage, model slot/model identifier, and outcome.
- [x] 2.2 Capture command/subprocess counts for each accounted invocation using existing command recording or injected deps rather than shell inspection.
- [x] 2.3 Classify cost as `actual` when sanitized provider/local usage exposes numeric cost data.
- [x] 2.4 Classify cost as `estimated` only when an explicit deterministic estimate is applied; otherwise classify it as `unknown` with `cost_usd: null`.
- [x] 2.5 Add regression coverage proving missing actual cost is not serialized as numeric zero.

## 3. Evidence Finalization

- [x] 3.1 Populate `summary.json.accounting.records` from chronological `stage_accounting` events during `finalizeRun()`.
- [x] 3.2 Add `summary.json.accounting.totals` with record count, actual cost USD, estimated cost USD, and unknown cost count.
- [x] 3.3 Preserve the same accounting object in legacy `<stateDir>/<issue>/evidence.json`.
- [x] 3.4 Ensure finalization comments continue to post only the bundle path and do not include accounting payloads or usage-derived values.

## 4. Scoreboard Reporting

- [x] 4.1 Extend scoreboard artifact loading to read `summary.json.accounting.records` and fall back to parseable `stage_accounting` events when summary data is missing or corrupt.
- [x] 4.2 Aggregate accounting records by issue, stage, harness, model slot/model identifier, and outcome.
- [x] 4.3 Emit JSON accounting groups with invocation count, duration, command count, subprocess count, actual cost USD, estimated cost USD, and unknown cost count.
- [x] 4.4 Add a human-readable cost/accounting section that distinguishes actual, estimated, and unknown costs.

## 5. Verification and Release Hygiene

- [x] 5.1 Add unit tests for accounting record shape, event append/stream behavior, usage allowlist sanitization, and actual/estimated/unknown classification.
- [x] 5.2 Add unit tests for summary finalization, legacy evidence mirroring, and finalization-comment privacy.
- [x] 5.3 Add unit tests for scoreboard grouping, event fallback, unknown-cost diagnostics, and JSON/human output.
- [x] 5.4 Add a regression check that accounting data does not change stage routing, label transitions, review harness selection, or merge behavior.
- [x] 5.5 Run `node scripts/build.mjs` after core edits and commit regenerated `plugin/` with the core changes.
- [x] 5.6 Run `npm run ci` from the repo root before marking implementation complete.
