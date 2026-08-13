## Why

The pipeline already records delivery activity and production/rework outcomes (#576), but it cannot yet measure how planning investment relates to downstream review and correction effort. Without versioned evidence for planning depth, unresolved assumptions, phase durations, and material rework, any future risk-calibrated progressive-planning policy would rest on intuition rather than observed leverage.

## What Changes

- Introduce a **versioned planning-leverage telemetry schema** that records phase boundaries (alignment/specification, planning, implementation, review, correction), selected planning depth and risk class, duration metrics, review effort, fix rounds, and material rework — as additive records and events, not a collapsed productivity score.
- Define **assumption and open-question lineage** with stable identities and resolution status carried from planning into implementation and review.
- Define **material rework** operationally so ordinary review edits are not treated as equivalent to material correction.
- Emit telemetry through the existing run event stream (`appendEvent` / `events.jsonl`) and optional host-local summary artifacts, preserving raw observations separately from derived metrics.
- Document how correction effort is represented when elapsed time, active effort, or cost is unknown; reporting distinguishes observed fields from inferred or unavailable values.
- Link cleanly to the #576 outcome-feedback model (runs, issues, commits, PRs, components, production/rework outcomes).
- Document privacy, retention, and customer-hosted deployment constraints (host-local default; no secrets/prompts/source; retention configurable).
- **Not in scope:** automatically changing planning depth; a universal “expected pain” or developer productivity score; causal impact claims before enough outcome data exists.

## Acceptance Criteria

- [ ] A versioned schema (`schema_version` integer, starting at `1`) represents phase boundaries, planning depth, risk class, assumption lineage, review effort, fix rounds, and material rework as distinct structured fields — not one numeric leverage score.
- [ ] Duration metrics derive from explicit timestamps and distinguish **elapsed wall time** from **known active effort**; when active effort or cost is unknown, fields use explicit `unknown` / null rather than inventing zeros.
- [ ] Assumptions and open questions retain stable identities and a resolution status that can be updated across planning, implementation, and review without losing history.
- [ ] Material rework has a closed operational definition (criteria + enums) such that not every review edit qualifies as material rework; tests include both positive and negative cases.
- [ ] Telemetry records link (when evidence exists) to `run_id`, issue, commit SHA(s), PR number(s), component identifiers, and #576 production-outcome ids or attribution targets; missing links are explicit diagnostics, not fabricated ids.
- [ ] Reporting (CLI and/or scoreboard section) separates **observed raw fields** from **derived metrics** and from **inferred/unavailable** values (e.g. authority or availability labels).
- [ ] Privacy, retention, and customer-hosted constraints are documented in design + specs and enforced by schema rules (no secrets/prompts/source; default host-local under `.agent-pipeline/`; configurable retention).
- [ ] Injected-deps unit tests cover schema compatibility, representative run lifecycles (plan → implement → review → fix → optional material rework), unknown-effort representation, and non-material vs material rework classification.
- [ ] Specs validate (`openspec validate planning-leverage-material-rework-telemetry`); implementation phase later keeps `npm run ci` green and regenerates `plugin/` only when `core/` changes.

## Capabilities

### New Capabilities

- `planning-leverage-telemetry`: Versioned planning-leverage record and event schema for phase boundaries, planning depth, risk class, durations (elapsed vs active), review effort, fix rounds; raw vs derived separation; privacy/retention defaults.
- `assumption-lineage`: Stable assumption and open-question identities, resolution status across stages, carry-forward without silent drop, redacted free-text rules.
- `material-rework-telemetry`: Operational definition of material rework vs ordinary review edits; counters and events for material correction effort; linkage to review findings and fix rounds.

### Modified Capabilities

- `events-jsonl-streaming`: Additive event types (or typed payloads) for planning-leverage / assumption / material-rework observations appended via `appendEvent` without changing base `schema_version` or existing stage-timeline filters.
- `factory-scoreboard`: Additive read-only reporting section for planning-leverage and material-rework aggregates over a window, with observed vs derived vs unavailable separation (no collapsed productivity score).
- `outcome-linkage`: Optional attribution target type or documented linkage path from planning-leverage records to production outcomes (#576) without inventing ids.

## Impact

- **Specs:** new `planning-leverage-telemetry`, `assumption-lineage`, `material-rework-telemetry`; deltas on `events-jsonl-streaming`, `factory-scoreboard`, `outcome-linkage`.
- **Code (implementation phase only):** schema/validators under `core/scripts/` (e.g. planning-leverage module); emitters at phase boundaries and fix rounds; scoreboard collector; optional CLI list surface; tests; `plugin/` regen if `core/` changes.
- **Storage:** host-local run `events.jsonl` plus optional summary under the run directory or `.agent-pipeline/` planning-leverage path; complementary to #576 outcomes store (outcomes often arrive later).
- **Dependencies:** consumes stage lifecycle / `stage_accounting`, planning artifacts (depth, risk class, assumptions), review/fix round counters, run identity and #576 linkage helpers.
- **Upstream/downstream:** prerequisite measurement for future progressive-planning policy; consumes #576 outcome model for join keys; does not auto-tune planning depth.
- **Operators:** scoreboard grows an additive section; no new required human diary; no merge/auto-merge or review rigor change.
- **Does not:** claim that deeper planning reduces rework; invent active-effort or cost when unknown; gate merge or FRG on leverage metrics in this change.
