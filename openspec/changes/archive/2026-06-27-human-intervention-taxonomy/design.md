## Context

The pipeline emits `blocker_set`, `blocker_cleared`, override records, and stage outcomes to `events.jsonl` and `summary.json`, but these are structurally heterogeneous. A reader wanting to answer "how many times did a review non-convergence block this issue?" must scrape prose or join multiple event types. There is no single normalized label on any event that says _why_ a human was needed.

Current touch points that need taxonomy labels:
- `blocker_set` events (from any stage that sets a blocking condition)
- Override records appended to `summary.json`
- `needs-human` stage transitions (review ceiling, eval failure, etc.)
- Plan-review feedback loops where a human edits the plan
- Ambiguous-issue / underspecified exits from planning

## Goals / Non-Goals

**Goals:**
- Define a stable, closed `HumanInterventionKind` enum with an `"unknown"` escape hatch.
- Emit one `human_intervention` event per intervention point (in addition to existing events; not a replacement).
- Add an optional `kind` field to override records (backward-compatible).
- Provide a summary aggregation helper that counts interventions by kind over a run window.
- Keep all original blocker/override/comment data intact alongside the normalized kind.

**Non-Goals:**
- Replacing or removing existing `blocker_set`, `blocker_cleared`, or override event types.
- Building a UI or dashboard — Pipeline Desk already reads `events.jsonl`.
- Automatically resolving or routing interventions based on kind.
- Retroactively re-annotating historical runs.

## Decisions

### 1. New module `core/scripts/intervention.ts` for the enum and emitter

Rather than inlining kind assignment into each stage, a dedicated module keeps the taxonomy single-sourced and testable independently. All stages call `emitHumanIntervention(deps, { kind, ... })` — a thin wrapper over `appendEvent`.

**Alternatives considered:** Adding `kind` directly to `blocker_set` events. Rejected because `blocker_set` events already have a stable schema and consumers may not want the taxonomy field mixed in; keeping a separate event type is additive and easier to filter.

### 2. Closed enum + `"unknown"` escape hatch

The kind is a string union (TypeScript), not a numeric enum, so it serializes readably to JSON. The set of valid values is documented in the spec. Any emission path that cannot map to a known kind uses `"unknown"` rather than failing. New kinds are added in source; consumers treat unrecognized strings as `"unknown"` for aggregation purposes.

**Taxonomy members (initial set):**

| Kind | Trigger |
|------|---------|
| `ambiguous-issue` | Planning exits because the issue is underspecified |
| `product-judgment-required` | Planning or fix stage defers to a human for a product decision |
| `plan-review-feedback` | Human edits or rejects the generated plan |
| `review-non-convergence` | Review ceiling reached; `needs-human` transition |
| `test-build-failure` | Test/build gate fails and auto-fix exhausted |
| `eval-shipcheck-failure` | Eval or ship-check gate fails |
| `merge-conflict-or-branch-drift` | Pre-merge detects a conflict or stale branch |
| `auth-tooling-preflight-failure` | Doctor preflight or auth check fails |
| `human-risk-override` | Operator supplies `--override` to accept a blocked finding |
| `reviewer-unavailable` | Same-harness fallback or reviewer cannot be reached |
| `unknown` | Catch-all for any intervention point not mapped above |

### 3. Event payload shape

```
{
  schema_version: 1,
  type: "human_intervention",
  at: <ISO 8601 UTC>,
  kind: <HumanInterventionKind>,
  stage: <stage name or null>,
  issue: <issue number>,
  detail: <free-form string — original blocker message, finding key, or override key>,
  ref: <string | null>  // e.g. finding key, override key, or PR number for correlation
}
```

`detail` preserves the original data verbatim; it is subject to the write-time injection denylist already applied to all events.

### 4. Override record augmentation

`OverrideRecord` (in `evidence-bundle`) gains an optional `kind?: HumanInterventionKind` field. Existing consumers ignore unknown fields; new consumers can filter by kind.

### 5. Summary aggregation

A pure helper `summarizeInterventions(events: Event[], windowMs?: number): InterventionSummary` groups `human_intervention` events by kind and returns counts. It is exposed via the `improve` command's `--interventions` flag (printing JSON) and used by the `last30days` context generator.

### 6. No new run-directory file

The `human_intervention` event is appended to the existing `events.jsonl`; no new file is introduced. `summary.json` gains `interventions` (array of `human_intervention` event objects) at finalization — an additive optional field.

## Risks / Trade-offs

- **Kind assignment subjectivity** → The mapping from existing blocker strings to kinds is done at call site; a mismatch silently emits `"unknown"`. Mitigation: the unit tests enumerate every expected call site and assert the mapped kind.
- **`"unknown"` inflation** → If new intervention paths are added without updating the taxonomy, `"unknown"` count grows, masking signal. Mitigation: `intervention.ts` exports a lint helper that enumerates call sites — run it in CI (or document that adding a block path requires a kind).
- **Audit faithfulness** → The original `detail` field must remain untruncated; the injection denylist may redact secrets. This is the same trade-off already accepted by `blocker_set` and override records.

## Migration Plan

1. Add `intervention.ts` with the enum, event shape, and `emitHumanIntervention` helper.
2. Add `kind` to `OverrideRecord` type (optional field).
3. Wire `emitHumanIntervention` at each stage block/exit/override call site.
4. Add `summarizeInterventions` helper and expose via `improve --interventions`.
5. Add unit tests per call site.
6. Update `openspec/specs/` deltas via archive.

Rollback: all changes are additive. Removing the `human_intervention` event type from consumers is safe; existing events continue to function.

## Open Questions

- Should `human_intervention` events be written to `summary.json` as a top-level `interventions` array, or just left in `events.jsonl` for consumers to filter? (Current decision: include in `summary.json` as optional field for one-shot consumers.)
- Should the `intervention-summary` command be a flag on `improve` or a standalone `interventions` subcommand? (Current decision: flag on `improve`, since `improve` already reads run artifacts.)
