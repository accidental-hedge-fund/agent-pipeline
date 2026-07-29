## 1. Closed class and pure mapper

- [x] 1.1 Define `PreMergeOfframpClass` / `PRE_MERGE_OFFRAMP_CLASSES` (closed const array + type) in a small core module (prefer co-locating near intervention/types or a dedicated helper imported by pre-merge emission and scoreboard).
- [x] 1.2 Implement a pure `toPreMergeOfframpClass(input)` mapper from `BlockerKind` and optional path tags (`ci-failed`, `delta-review`, …) → class; residual → `other`.
- [x] 1.3 Unit tests: every documented pre-merge kind/path maps as specified; unknown/missing → `other`; mapper has no I/O.

## 2. Durable event shape

- [x] 2.1 Extend `BlockerSetEvent` (or the chosen off-ramp event) with additive optional fields: `stage`, `blocker_kind`, `offramp_class` (schema_version remains `1`).
- [x] 2.2 Update the orchestrator `blocker_set` append path in `pipeline-run.ts` so blocked stage results pass `stage`, `blockerKind`, and computed `offramp_class` when stage is `pre-merge` (and safely omit/null for other stages).
- [x] 2.3 Unit/regression tests for event payload shape with fixture deps (no real filesystem beyond test temp if already used by run-store tests).

## 3. Pre-merge instrumentation

- [x] 3.1 Audit every pre-merge `setBlocked` / blocked return path; ensure each supplies an explicit `BlockerKind` and returns `blockerKind` on `StageResult` where missing.
- [x] 3.2 Map CI failure paths to a class of `ci-failed` (via kind and/or path tag) instead of collapsing only to generic `needs-human` for metric purposes.
- [x] 3.3 Map delta-review / review-SHA blocking paths to `delta-review`.
- [x] 3.4 Confirm merge-conflict and OpenSpec paths keep `merge-conflict` / `openspec-invalid` / `openspec-stale-delta` kinds that map correctly.
- [x] 3.5 Confirm `waiting` and successful advance paths do not emit an off-ramp class event.
- [x] 3.6 Regression tests on pre-merge stage fakes covering at least CI, delta-review, merge-conflict, and OpenSpec blocked outcomes → correct `blockerKind` / class on the result or emission seam.

## 4. Scoreboard aggregation

- [x] 4.1 Extend `ScoreboardMetrics` with `pre_merge_needs_human` (rate + by_class) using the existing `RateValue` shape and zero-denominator → `null` rule.
- [x] 4.2 Implement collectors: pre-merge entry denominator (stage_start or pinned signal) and pre-merge off-ramp events with class priority rules from the design.
- [x] 4.3 Wire human-readable and HTML formatters to print the new section; leave `schema_version` unchanged (additive keys only).
- [x] 4.4 Ensure `--bucket` period metrics recompute the same shapes from period-local runs.

## 5. Tests and fixtures

- [x] 5.1 Fixture run store: mixed classes + one historical event without `offramp_class` → residual/`other` still counted; no crash.
- [x] 5.2 Fixture: zero pre-merge entries → null ratios.
- [x] 5.3 Fixture: class counts sum to total numerator; denominator is pre-merge entries not all runs.
- [x] 5.4 Fixture: day bucket splits classes across days; full-window summary unchanged with/without `--bucket`.
- [x] 5.5 Prove scoreboard path does not call gh (existing read-only pattern / no gh in deps).

## 6. Documentation

- [x] 6.1 Document dogfood-day query in scoreboard help and the relevant README / user docs section (`pipeline scoreboard --days 1 --json` + JSON path for the aggregate).
- [x] 6.2 Note classification source is run events, not issue comments; note papercut class-threshold auto-file as explicit follow-up out of scope.

## 7. Mirror and CI gate

- [x] 7.1 After any `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/` in the same change set as implementation.
- [x] 7.2 Run `npm run ci` from repo root and fix failures until green.
