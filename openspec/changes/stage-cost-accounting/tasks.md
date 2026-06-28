## 1. Accounting Model and Artifact Helpers

- [ ] 1.1 Inspect current stage, harness, command-recording, event, evidence, and scoreboard call sites to identify the narrowest capture points.
- [ ] 1.2 Add a `StageAccountingRecord` type with required fields for issue, run, stage, harness, model slot/model identifier, timing, counts, outcome, blocker kind, cost source, cost USD, and optional sanitized usage counters.
- [ ] 1.3 Add allowlist-based usage extraction helpers that keep only numeric usage/cost fields and approved identifiers, then pass persisted strings through existing artifact redaction.
- [ ] 1.4 Add a non-fatal helper for appending `stage_accounting` events to `events.jsonl`, preserving `--json-events` streaming behavior.

## 2. Invocation Capture

- [ ] 2.1 Wrap harness invocation paths so each completed invocation records start/end or duration, harness, stage, model slot/model identifier, and outcome.
- [ ] 2.2 Capture command/subprocess counts for each accounted invocation using existing command recording or injected deps rather than shell inspection.
- [ ] 2.3 Classify cost as `actual` when sanitized provider/local usage exposes numeric cost data.
- [ ] 2.4 Classify cost as `estimated` only when an explicit deterministic estimate is applied; otherwise classify it as `unknown` with `cost_usd: null`.
- [ ] 2.5 Add regression coverage proving missing actual cost is not serialized as numeric zero.

## 3. Evidence Finalization

- [ ] 3.1 Populate `summary.json.accounting.records` from chronological `stage_accounting` events during `finalizeRun()`.
- [ ] 3.2 Add `summary.json.accounting.totals` with record count, actual cost USD, estimated cost USD, and unknown cost count.
- [ ] 3.3 Preserve the same accounting object in legacy `<stateDir>/<issue>/evidence.json`.
- [ ] 3.4 Ensure finalization comments continue to post only the bundle path and do not include accounting payloads or usage-derived values.

## 4. Scoreboard Reporting

- [ ] 4.1 Extend scoreboard artifact loading to read `summary.json.accounting.records` and fall back to parseable `stage_accounting` events when summary data is missing or corrupt.
- [ ] 4.2 Aggregate accounting records by issue, stage, harness, model slot/model identifier, and outcome.
- [ ] 4.3 Emit JSON accounting groups with invocation count, duration, command count, subprocess count, actual cost USD, estimated cost USD, and unknown cost count.
- [ ] 4.4 Add a human-readable cost/accounting section that distinguishes actual, estimated, and unknown costs.

## 5. Verification and Release Hygiene

- [ ] 5.1 Add unit tests for accounting record shape, event append/stream behavior, usage allowlist sanitization, and actual/estimated/unknown classification.
- [ ] 5.2 Add unit tests for summary finalization, legacy evidence mirroring, and finalization-comment privacy.
- [ ] 5.3 Add unit tests for scoreboard grouping, event fallback, unknown-cost diagnostics, and JSON/human output.
- [ ] 5.4 Add a regression check that accounting data does not change stage routing, label transitions, review harness selection, or merge behavior.
- [ ] 5.5 Run `node scripts/build.mjs` after core edits and commit regenerated `plugin/` with the core changes.
- [ ] 5.6 Run `npm run ci` from the repo root before marking implementation complete.
