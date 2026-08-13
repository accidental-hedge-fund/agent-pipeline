## Why

Factory evidence today measures pipeline behavior (R2D rate, review rounds, interventions) far better than whether accepted changes held up after delivery. Without first-class linkage from pipeline runs and delivered candidates to production and rework signals, the factory cannot learn from reversions, incidents, follow-up rework, or post-control recurrence — and R2D is easy to confuse with production success.

## What Changes

- Introduce a **versioned production-outcome record schema** that stores concrete outcome kinds (delivery observation, reversion/rollback, escaped defect/incident, follow-up rework, change amplification, post-control recurrence) **without** collapsing them into one score or universal maintainability number.
- Define **identity and linkage rules** that associate outcomes to pipeline runs, commits, pull requests, and affected components when evidence exists, and that represent **unknown, delayed, disputed, and many-to-many** attribution explicitly.
- Preserve the delivery chain **ready-to-deploy → merge → deployment**: pipeline completion is never treated as production delivery. Delivery observations record environment/status, deployed candidate SHA, verification evidence and freshness, rollback outcome, and explicit `unknown` / `not_observed` states.
- Define a **source-adapter contract** for ingesting outcomes from external systems, and ship **at least one end-to-end adapter** (GitHub-native: merge/revert/deployment signals) that demonstrates ingestion and linkage offline-computable from durable store + optional read-only GitHub.
- Extend **factory scoreboard / outcome reporting** so operators can list observed outcomes and any attribution claims separately: **observed facts** vs **inferred linkage** are never mixed as equal authority.
- Document **privacy, retention, and customer-hosted** constraints: default host-local store under `.agent-pipeline/`; no raw secrets/prompts/source; retention configurable; no claim of causal attribution from correlation alone.

**Not in scope:** causal inference engines; auto-merge or gates driven by outcome scores; a single maintainability score; full multi-vendor incident platforms beyond the adapter contract + one GitHub E2E adapter; planning-leverage telemetry (#702 — consumes this model later).

## Acceptance Criteria

- [ ] A versioned schema (`schema_version` integer, starting at `1`) represents at least the outcome kinds named in What Changes as distinct records or typed variants — not one numeric score field.
- [ ] Each outcome record can link (when evidence exists) to `run_id`, commit SHA(s), PR number(s), issue number(s), and component identifiers; missing links are explicit null/empty with reason codes, not silent omission that looks like “none.”
- [ ] Observation state vocabulary includes at least `observed`, `delayed`, `unknown`, `not_observed`, and `disputed`; many-to-many attribution is representable without forcing a single primary target.
- [ ] Delivery-chain fields exist for environment/status, deployed candidate SHA, verification evidence ref + freshness, and rollback outcome (or explicit unknown/not-observed for each).
- [ ] Ready-to-deploy final state alone never counts as a successful production delivery observation.
- [ ] At least one GitHub-native source adapter ingests a fixture/signal end-to-end into durable outcome records with linkage fields populated or explicitly unresolved.
- [ ] Reporting surfaces (CLI and/or scoreboard JSON) separate **observed outcome facts** from **attribution/inference claims** (e.g. confidence, method, or `observed` vs `inferred` flags).
- [ ] Privacy/retention/customer-hosted constraints are documented in design + specs and enforced by schema rules (no secrets/prompts/source in outcome payloads; default local store; configurable retention window).
- [ ] Injected-deps unit tests cover schema validation, linkage rules, delayed/unknown states, many-to-many, adapter ingest of a fixture, and reporting separation of observed vs inferred.
- [ ] Specs validate (`openspec validate production-outcome-linkage`); implementation phase later keeps `npm run ci` green and regenerates `plugin/` only when `core/` changes.

## Capabilities

### New Capabilities

- `production-outcome-records`: Versioned multi-kind outcome records, delivery-chain fields, observation states (`observed` / `delayed` / `unknown` / `not_observed` / `disputed`), retention and redaction rules, host-local store layout.
- `outcome-linkage`: Rules and data shapes that bind outcomes to runs, commits, PRs, issues, and components; many-to-many and disputed attribution; explicit observed-vs-inferred authority.
- `outcome-source-adapters`: Pluggable ingest adapter contract; GitHub-native end-to-end adapter for merge/revert/deployment-class signals; non-fatal ingest and diagnostics.

### Modified Capabilities

- `factory-scoreboard`: Additive read-only reporting of production/rework outcomes over a window, with counts by kind and observation state, and explicit separation of observed outcomes from inferred attribution (no single collapsed score).

## Impact

- **Specs:** new `production-outcome-records`, `outcome-linkage`, `outcome-source-adapters`; delta on `factory-scoreboard`.
- **Code (implementation phase only):** outcome store module under `core/scripts/` (schema, validate, append/read, retention); linkage pure helpers; adapter interface + GitHub adapter; scoreboard collector; CLI surface (e.g. `pipeline outcomes` ingest/list or scoreboard section); tests; `plugin/` regen if `core/` changes.
- **Storage:** host-local `.agent-pipeline/outcomes/` (or equivalent documented path) complementary to run dirs; outcomes arrive after runs end and may be delayed.
- **Dependencies:** consumes run identity (`run_id`, issue, PR, candidate SHA from run store / trailers / evidence_subject); does not replace control-attribution or escape-recurrence — recurrence-after-control outcomes may reference those records as evidence.
- **Downstream:** #702 (planning-leverage / material-rework telemetry) and later warrant/run-card work (#798/#799) link to this model.
- **Operators:** optional ingest command; scoreboard grows additive sections; no new required human diary; no merge/auto-merge behavior change.
- **Does not:** claim causation; invent production success from R2D; gate merge or FRG on outcome metrics in this change.
