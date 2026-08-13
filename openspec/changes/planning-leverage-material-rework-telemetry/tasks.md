## 1. Schema and pure validation

- [ ] 1.1 Define TypeScript types and closed enums for phases, planning_depth, risk_class, materiality, material_criteria, assumption status/kind, duration availability, active_effort source/availability, and `record_schema_version: 1` payload shapes in a dedicated core module (e.g. `core/scripts/planning-leverage/schema.ts`).
- [ ] 1.2 Implement pure validators/builders that accept well-formed records, reject out-of-enum values, forbid inventing placeholder run/outcome ids, and refuse silent zero-fill for unknown active effort or cost.
- [ ] 1.3 Implement pure materiality classifier from documented criteria with fixtures for ordinary, material (interface change + multi-round), and unknown.
- [ ] 1.4 Unit tests: schema closed enums locked; elapsed only when both timestamps present; active effort unavailable ≠ 0/elapsed; materiality positive/negative cases; unknown fields ignored by readers; free-text redaction before serialize.

## 2. Assumption lineage

- [ ] 2.1 Implement stable `assumption_id` allocation and current-state projection (latest event per id per run) as pure helpers.
- [ ] 2.2 Support create/update transitions (`open` → `resolved` / `invalidated` / `deferred`) without changing identity.
- [ ] 2.3 Unit tests: resolve reuses id; history retained in event list; unresolved counts exclude resolved; reopen keeps id.

## 3. Event emission via appendEvent

- [ ] 3.1 Extend run-store event union / append helpers for `planning_leverage_phase`, `assumption_lineage`, `material_rework`, and optional `planning_leverage_snapshot` without bumping base stream `schema_version` past `1`.
- [ ] 3.2 Emit phase start/end at alignment, planning, implementation, review, and correction boundaries with selected `planning_depth` and `risk_class` (or `unknown`).
- [ ] 3.3 Emit assumption lineage when planning records or later stages resolve/invalidate items; carry open items into later phases without drop.
- [ ] 3.4 Emit material_rework at fix-round completion using the classifier; include review_effort counters when known.
- [ ] 3.5 Confirm event-sink delivery and denylist/redaction apply identically to other `appendEvent` types (tests with injected sink).
- [ ] 3.6 Unit tests: representative lifecycle plan → implement → review → fix; stage-timeline filters still ignore new types; sink byte-identical line.

## 4. Optional per-run snapshot and linkage

- [ ] 4.1 Build optional snapshot (summary section or host-local file) that separates raw observations from `derived` metrics with availability labels.
- [ ] 4.2 Wire attribution helpers: observed run identity; optional production_outcome join only when outcome store evidence exists; diagnostics when unresolved.
- [ ] 4.3 Unit tests: no fabricated outcome ids; observed vs inferred authority; snapshot derived unavailable when inputs missing.

## 5. Scoreboard reporting

- [ ] 5.1 Extend `pipeline scoreboard` collectors to read planning-leverage family events/snapshots over the report window.
- [ ] 5.2 Emit additive `planning_leverage` section: depth/risk histograms, phase elapsed (observed only), assumption open/resolved, materiality breakdowns; no productivity/leverage/expected-pain score.
- [ ] 5.3 Label observed vs derived vs unavailable in JSON and human output; missing telemetry → zeros + `telemetry_absent` diagnostic.
- [ ] 5.4 Unit tests: depth counts; ordinary vs material; unavailable active effort not zero-fact; empty telemetry non-fatal.

## 6. Docs surface and privacy notes

- [ ] 6.1 Document CLI/scoreboard fields, phase enums, materiality criteria, and unknown-effort representation in the appropriate generated or hand docs path used by this repo.
- [ ] 6.2 Document host-local default, redaction, retention, and customer-hosted no-fleet requirement (design already states; keep code comments / help text in sync).

## 7. Mirror, OpenSpec, and CI

- [ ] 7.1 After any `core/` edits: `node scripts/build.mjs` and commit regenerated `plugin/` with the same change set.
- [ ] 7.2 Run `openspec validate planning-leverage-material-rework-telemetry` (and `openspec validate --all` in CI path) until green.
- [ ] 7.3 Run `npm run ci` from repo root until green.
- [ ] 7.4 Confirm no auto-merge path, no planning-depth auto-policy, no collapsed productivity score, and no causal claims landed.
