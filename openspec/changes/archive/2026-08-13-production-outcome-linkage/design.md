## Context

Pipeline runs already leave durable artifacts under `.agent-pipeline/runs/<run-id>/` (`run.json`, `events.jsonl`, `summary.json`) and stamp `Issue` / `Pipeline-Run` trailers on commits. Factory scoreboard aggregates factory behavior from those runs. Control-attribution and escape-recurrence track **factory defect classes**, not customer production health. Deploy_ready stops at R2D and never merges; merge is a separate operator-authorized path. No first-class record today says “this candidate was deployed,” “this PR was reverted,” or “this subsystem saw post-ship rework.”

See proposal.md for motivation and acceptance criteria.

## Goals / Non-Goals

**Goals:**

- Versioned multi-kind outcome records that stay separate (no single score).
- Explicit delivery chain R2D → merge → deployment with unknown/not-observed first-class.
- Linkage model that tolerates delayed evidence, many-to-many targets, and disputed claims.
- Adapter contract + one GitHub-native E2E path proven with fixtures (no live network in unit tests).
- Scoreboard/report surfaces that label authority: observed fact vs inferred attribution.
- Privacy-safe default for customer-hosted installs (local store, redaction, retention).

**Non-Goals:**

- Causal models or automatic blame assignment.
- Universal maintainability score or FRG/merge gates driven by outcomes.
- Multi-vendor incident platforms beyond the adapter interface (PagerDuty, Datadog, etc. are future adapters).
- Rewriting run directories when outcomes arrive later.
- Replacing escape-recurrence / control-attribution for factory-internal defect classes.

## Decisions

### D1 — Separate outcome store, not in-run mutation

**Decision:** Persist outcomes under a host-local durable store

`.agent-pipeline/outcomes/<outcome-id>.json`

(and an optional append-only `outcomes.jsonl` index for scan efficiency), **not** by rewriting finalized `summary.json` of historical runs.

**Rationale:** Outcomes often arrive days after R2D/merge; run artifacts are write-once / finalize-oriented. A side store keeps run immutability and supports late, disputed, and multi-run attribution.

**Alternatives:** Embed outcomes only in the producing run’s directory — rejected (late arrivals force mutation or orphan files). Fleet-only store — rejected for v1 (customer-hosted must work offline).

### D2 — Outcome kinds are a closed enum; metrics stay multi-dimensional

**Decision:** `outcome_kind` is exactly one of:

| Kind | Meaning |
| --- | --- |
| `delivery` | Deployment/environment observation for a candidate (status, env, SHA, verification, rollback) |
| `reversion` | Revert of a delivered change (e.g. revert PR, rollback deploy) |
| `escaped_defect` | Defect/incident attributed after ship (customer or production signal) |
| `follow_up_rework` | Material follow-up work on the same subsystem/change line |
| `change_amplification` | Measured expansion of touch surface (files/components) beyond the original delivery |
| `post_control_recurrence` | Recurrence after an approved control/correction boundary (may cite control_attribution) |

No field `overall_score`. Aggregates are counts/rates **by kind** and by observation state.

**Rationale:** Issue forbids collapsing outcomes into one score; kinds map to the issue’s signal list.

**Alternatives:** Free-text kinds only — rejected (metrics and adapters need a closed set). Single “badness” score — explicitly out of scope.

### D3 — Observation state and attribution authority are separate axes

**Decision:**

1. **`observation_state`**: `observed` | `delayed` | `unknown` | `not_observed` | `disputed`
2. **`attribution`**: list of targets (`run_id`, `issue`, `pr`, `commit_sha`, `component_id`) each with:
   - `method`: `direct` | `trailer` | `heuristic` | `manual` | `adapter`
   - `authority`: `observed` | `inferred`
   - optional `confidence` in `[0, 1]` or null
   - optional `note` (bounded, redacted)

Many-to-many: an outcome MAY list multiple targets; none is required to be “primary.” Disputed outcomes keep all claims and set `observation_state: disputed` (or per-claim dispute flags) rather than deleting history.

**Rationale:** Delayed signals and multi-PR incidents are normal; conflating “we saw a revert” with “we are sure it is run X” is the main failure mode.

**Alternatives:** Single foreign key to `run_id` — rejected (many-to-many, delayed). Inference written as fact — rejected by acceptance criteria.

### D4 — Delivery chain is an explicit record family, not implied by R2D

**Decision:** A `delivery` outcome (or nested `delivery` block on related kinds when relevant) SHALL carry:

- `environment` (string or null)
- `deploy_status` (`succeeded` | `failed` | `rolled_back` | `in_progress` | `unknown` | `not_observed`)
- `deployed_candidate_sha` (40-char hex or null)
- `verification` (`evidence_ref`, `fresh_at` ISO or null, `status`)
- `rollback` (`occurred` bool or null, `outcome` enum or null, observation_state)

Rules:

- `summary.json.finalState === ready-to-deploy` alone **must not** create a `delivery` with `deploy_status: succeeded`.
- Merge evidence (operator merge command events / GitHub merged_at) may create or update a **merge step** observation distinct from deploy.
- Missing deploy signal → `not_observed` or `unknown`, never silent success.

**Rationale:** Recommendation upsert (2026-07-31) and issue non-goals both require R2D ≠ production delivery.

### D5 — Source adapters: small interface, GitHub first

**Decision:**

```text
OutcomeSourceAdapter {
  id: string
  discover(ctx): AsyncIterable<RawOutcomeSignal>
  normalize(signal): ProductionOutcomeRecord | null  // pure-ish; may use pure helpers
}
```

- Ingest command (e.g. `pipeline outcomes ingest --adapter github`) is **read-only toward GitHub** and **append-only** toward the outcome store (idempotent by `outcome_id` derived from stable signal identity).
- **GitHub adapter** v1 consumes: merged PRs with trailers / linked issues; revert PRs (`Reverts #N` / revert commits); optional GitHub Deployments or environment statuses when present in fixture/API shape.
- Unit tests inject fake `gh`/fs deps and fixtures; no live network.

**Rationale:** Meets “at least one E2E adapter”; matches existing gh wrapper style; leaves room for incident tools later without schema fork.

**Alternatives:** Manual-only recording — fails E2E acceptance. Webhook server — out of scope for v1.

### D6 — Privacy, retention, customer-hosted

**Decision:**

- Default store is **host-local** under the repository’s `.agent-pipeline/` (same trust boundary as run store).
- Outcome free-text fields pass existing injection denylist + secret redaction; **no** raw prompts, model output, source dumps, or env secrets.
- Component identifiers are path prefixes or logical module keys already used in-repo — not customer PII.
- Retention: configurable window (config key or CLI flag); expired records excluded from default reports; delete is explicit/operator-scoped for customer-hosted cleanup.
- Fleet export of outcomes is **out of v1** unless already covered by fleet envelope rules; if later exported, reuse fleet-data-governance (pseudonymous ids, no human identity).

**Rationale:** Mirrors fleet-data-governance principles without requiring fleet for dogfood.

### D7 — Scoreboard integration is additive and labeled

**Decision:** `pipeline scoreboard --json` gains an `outcomes` object:

- counts by `outcome_kind` and `observation_state`
- lists/samples of **observed** vs **inferred** attribution claims (or separate arrays)
- diagnostics for unresolved linkage and stale verification
- **no** `maintainability_score` field

Optionally a thin `pipeline outcomes list --json` for debugging ingest.

**Rationale:** Operators already use scoreboard windows; separation of authority is an acceptance criterion.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Heuristic linkage false positives | Mark `authority: inferred`; never auto-gate on inferred claims; diagnostics for low confidence |
| Incomplete GitHub deployment data | `not_observed` / `unknown` statuses; do not invent success |
| Store growth | Retention window; compact index; outcomes are small JSON |
| Confusion with escape-recurrence | Document: factory defect-class recurrence vs production `post_control_recurrence` / `escaped_defect`; shared references only via explicit evidence_ref |
| Adapter API drift (`gh --json` fields) | Confirm shapes with real `gh` before coding; fixtures lock field names |

## Migration Plan

1. Land schema + pure validators/tests (no production behavior change).
2. Land store + ingest command + GitHub adapter against fixtures.
3. Wire scoreboard section; document CLI.
4. Dogfood on agent-pipeline itself: ingest after merges/reverts; confirm R2D runs without delivery still show `not_observed`.
5. Rollback: disable ingest/scoreboard section; leave store files ignored by older engines (unknown files under `.agent-pipeline/` are already non-fatal to advance).

## Open Questions

- Exact config key for retention days (reuse a generic evidence retention key if one exists at implement time).
- Whether merge observations live as a sub-state of `delivery` or a separate kind — default in specs: merge is a step inside the delivery chain fields on `delivery`, not a seventh kind, unless implementation discovers a cleaner split without schema conflict.
