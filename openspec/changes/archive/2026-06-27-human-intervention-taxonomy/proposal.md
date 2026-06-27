## Why

Human intervention points (blockers, overrides, `needs-human` exits, plan-review feedback, merge conflicts) are not tracked under a shared, stable taxonomy. Without normalized categories, repeated human touches cannot be measured, trended, or fed back as factory-improvement signals.

## What Changes

- Introduce a closed `HumanInterventionKind` enum (with an open `"unknown"` escape hatch) covering every situation where the pipeline exits to a human or emits an override.
- Emit a `human_intervention` event to `events.jsonl` at every point where the pipeline currently blocks, records an override, or transitions to `needs-human`, carrying the kind, the original blocker/override data, and the issue/run context.
- Add a `kind` field to existing override records in `summary.json` so the taxonomy is present there too.
- Expose a `--interventions` summary view on the `doctor` or `improve` subcommand (or a new `interventions` query) that counts and lists interventions by kind over a configurable run window.
- Document the taxonomy in the spec so future kinds can be added without breaking existing consumers.

## Capabilities

### New Capabilities
- `human-intervention-taxonomy`: The closed enum of intervention kinds, the factory-record shape, and the forward-compatibility rules (unknown escape hatch).
- `human-intervention-events`: Emission of `human_intervention` events at every pipeline block/exit/override point.
- `intervention-summary`: A consumer-facing query or command flag that aggregates intervention counts by kind over a run window.

### Modified Capabilities
- `events-jsonl-streaming`: New `human_intervention` event type appended to the stream alongside existing `blocker_set`, `blocker_cleared`, and `stage_complete` events.
- `evidence-bundle`: Override records in `summary.json` gain an optional `kind` field mapping the override to the taxonomy.

## Impact

- `core/scripts/stages/*.ts` — each stage that sets a blocker, posts a `needs-human` transition, or records an override gets a one-line call to emit the new event.
- `core/scripts/` — new `intervention.ts` module defining the enum, the event shape, and the emitter helper.
- `events.jsonl` consumers (Pipeline Desk, `improve` command, `last30days` context) gain richer filtering.
- No breaking changes: `kind` on override records is optional; the `human_intervention` event type is additive.

## Acceptance Criteria

- [ ] Every pipeline block, override, and `needs-human` exit emits a `human_intervention` event to `events.jsonl` with a stable `kind` field drawn from the taxonomy enum.
- [ ] The taxonomy enum is documented and includes an `"unknown"` escape hatch for future kinds.
- [ ] All existing blocker/override/`needs-human` data is preserved alongside the normalized `kind` (no hidden original data).
- [ ] Override records in `summary.json` carry an optional `kind` field.
- [ ] A summary query (command flag or subcommand) counts interventions by kind over a configurable run window and outputs a machine-readable result.
- [ ] Unit tests cover: kind assignment for each taxonomy member, event shape validation, and the summary aggregation logic.
- [ ] `npm run ci` passes with the new module and tests in place.
