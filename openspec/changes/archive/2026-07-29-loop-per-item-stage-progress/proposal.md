## Why

A durable `pipeline:loop` run is observable mainly through coarse ledger item states
(`pending` / `in_progress` / `blocked` / `ready` / …) and supervisor scheduling
`action_evidence`. Mid-flight pipeline stage progress — that `#607` is at
`plan-review (round 1)` vs `implementing` — exists only inside the per-item advance
log, interleaved with harness stream-of-consciousness. Operators grepping
`pipeline logs <item-run-id> --follow` or polling `gh issue view` cannot answer
"where is every item in this run right now?" from the loop surface alone. Related
v1.28.2 work (#665 handoff, #666 loop logs follow, #667 advance-run linkage) made
join keys and event streams reachable, but still left no first-class **per-item
stage-progress** field or audit/follow rendering of it.

## What Changes

- **Durable per-item current-stage signal.** As each item advances, the loop records
  a first-class current-stage projection on that item in the durable ledger (or an
  equivalent durable per-item field under the loop run directory): the `pipeline:*`
  stage the item is in, plus fix/review round when applicable. This signal is
  **distinct** from the coarse ledger item `state` and is updated on stage
  transition (not only at dispatch start/end).
- **Audit stage table.** `pipeline loop --audit` (with `--resume <run-id>` when
  required) renders a per-item stage table for the run: item id, current stage
  (or queued/pending presentation), and the item's advance run-id when known so
  operators can drill into `pipeline logs <advance-run-id> --follow`.
- **Loop-level stage-progress follow.** A follow mode
  (`pipeline loop --resume <run-id> --follow`, and/or `--audit --follow`) streams
  **clean, one-line, structured stage-transition events** for the whole run — not
  by re-emitting interleaved harness stdout — and includes each item's advance
  run-id on those events when known.
- **Observational only.** Stage progress is projected from the child's advance
  evidence (linked advance run store / labels already observed by reconciliation).
  The supervisor still hands off whole items and still does **not** own pipeline
  stage labels, merge, or review autonomy.
- **Rigor-preserving.** No change to the label state machine, review coverage,
  autonomy, recovery budgets, or the `ready-to-deploy` human handoff.

## Acceptance criteria

- [ ] While an item is mid-advance, the durable loop run records a per-item
      **current-stage** signal (pipeline stage name, plus review/fix round when
      applicable) that is distinct from that item's coarse ledger `state`
      (`in_progress` alone is not enough).
- [ ] That current-stage signal is updated when the item transitions pipeline
      stages during the advance (e.g. planning → implementing → review round N),
      not only at dispatch start or terminal outcome.
- [ ] `pipeline loop --audit` (targeting an existing run) prints a per-item stage
      table that includes, for each selector item: item id, current stage (or a
      clear queued/pending presentation), and the advance run-id when one is known
      for that item.
- [ ] From the audit stage table alone, an operator can identify which item is
      active and which advance run-id to pass to `pipeline logs … --follow`
      without grepping harness stdout or scanning `.agent-pipeline/runs/*` by mtime.
- [ ] A documented follow mode (`pipeline loop --resume <run-id> --follow` and/or
      `pipeline loop --audit --follow`) streams whole-run stage-transition lines as
      structured one-line events (item id + stage + optional round + advance
      run-id when known) and does **not** re-emit interleaved per-item harness
      terminal prose.
- [ ] Follow mode remains read-only observation: no ledger mutation beyond what
      the live supervisor already records, no lock theft, no GitHub mutation, and
      no run-liveness reservation for the follower process.
- [ ] Unit tests with injected store / advance-event seams cover: (1) stage
      signal recorded and updated on transition, (2) audit table includes stage +
      advance run-id, (3) follow emits structured stage events without harness
      stdout, (4) coarse `state` and current-stage remain distinct. At least one
      regression fails against today's audit surface that omits per-item stage.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` when `core/` changes,
      install smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-item-stage-progress`: first-class per-item pipeline stage-progress
  observability for durable loop runs — durable current-stage signal (distinct
  from coarse item state), audit stage table with advance run-id drill-down, and
  whole-run structured stage-transition follow without harness stdout.

### Modified Capabilities

- `durable-loop-store`: ledger (or equivalent durable per-item document fields)
  may carry a per-item current-stage projection updated on stage transition;
  status projection exposes it read-only.
- `durable-loop-supervisor`: during item advance, records/updates the per-item
  current-stage signal from observed advance evidence; still does not own stage
  labels or merge.
- `pipeline-loop-facade`: `--audit` output includes the per-item stage table;
  accepted observation flags include a documented `--follow` path for stage
  progress (resume and/or audit).
- `loop-dispatch-advance-linkage`: consumers of start linkage use the advance
  run-id not only for join keys but as the audit/follow drill-down target
  presented alongside stage progress (no change to linkage semantics beyond
  requiring the progress surface to prefer the real advance run-id when known).

## Impact

- `core/scripts/loop/types.ts` / ledger schema — additive per-item current-stage
  fields (stage name, optional round, updated-at, optional advance run-id mirror).
- `core/scripts/loop/store.ts` — status projection and ledger read/write paths
  surface the new fields; schema compatibility rules for additive fields.
- `core/scripts/loop/supervisor.ts` — while waiting on a dispatched item (or via
  a small observer on the linked advance `events.jsonl`), update stage progress
  and append structured stage-transition events on the loop run trail.
- `core/scripts/pipeline.ts` (loop CLI / audit rendering) — stage table in
  `--audit`; wire `--follow` observation path if not already accepted by the
  facade/preflight allowlist.
- Reuses #667 advance-run linkage and advance `stage_start` / `stage_complete` /
  `review_verdict` events; does not re-parse harness terminal prose.
- `core/test/` — injected unit tests; regenerate `plugin/` if CLI/help text under
  `core/` is mirrored.
- Out of scope: label state machine changes; review policy; merge/auto-merge;
  bridging full harness stdout into the loop stream; async multi-detach
  redesign; cross-host lock model changes.
