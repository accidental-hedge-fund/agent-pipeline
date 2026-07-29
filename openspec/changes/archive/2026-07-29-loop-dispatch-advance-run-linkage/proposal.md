## Why

When the durable loop dispatches an item, it runs a synchronous child advance and waits
for exit, but the `pipeline/loop-execution@1` response fabricates evidence like
`pipeline-loop-${run_id}-${item_id}` instead of the real per-item advance run-store id
under `.agent-pipeline/runs/`. Harnesses that already follow supervisor events therefore
cannot attach to the active item's `events.jsonl` (`stage_start`, `review_verdict`, …)
the way `/pipeline N` does. Loop visibility stays coarse (`loop_item_started` → long
silence → `loop_item_transitioned`) even though the child is already writing a full
stage timeline.

This is the third item in the v1.28.2 loop harness event-streaming cluster (#665 early
handoff → #666 loop logs follow → **#667 dispatch linkage** → #668 skill orchestration).
Without real join keys, logs follow and skill multiplex cannot surface the same stage
timeline for the active loop item.

## What Changes

- **Real advance run-store identity is published as the join key.** When a per-item
  advance creates (or is pinned to) a run store under
  `.agent-pipeline/runs/<issue-timestamp>/`, that directory's run id — not a synthetic
  `pipeline-loop-…` string — is the `pipeline_run_id` consumers use to follow stage
  progress.
- **Dispatch start publishes linkage.** At item dispatch start (or as soon as the child
  run store is known), the loop records a durable supervisor event and/or handoff field
  carrying at least: `item_id`, real `pipeline_run_id`, and absolute `events` path when
  known.
- **Dispatch end publishes terminal linkage.** When the child returns a terminal
  outcome, the loop records durable terminal linkage (outcome + the same ids) so audit
  can join supervisor and advance evidence after the fact.
- **Evidence pointer stops lying when a real store exists.**
  `LoopEvidencePointer.pipeline_run_id` SHALL be the real advance run-store id when that
  store exists. Synthetic-only `pipeline-loop-…` ids SHALL NOT be the sole join key in
  that case (they may remain only as a last-resort fallback when no run store can be
  established).
- **Optional absolute events path on the evidence pointer.** When known, the response
  MAY/SHALL carry an absolute path to the advance `events.jsonl` so consumers need not
  re-derive layout.
- **No async multi-detach redesign.** The supervisor may keep synchronous child advance
  (`spawn` + wait). Fully async multi-detach children remain out of scope.
- **No skill-text-only fix; no merge path.**

## Acceptance criteria

- [ ] When the loop dispatches an item whose advance run store is known, a durable
      supervisor-side event (or equivalent handoff field readable from the loop run
      directory) is present **before or at the start of** the long in-flight window and
      carries `item_id`, the real advance `pipeline_run_id` (matching
      `.agent-pipeline/runs/<run-id>/`), and the absolute `events.jsonl` path when that
      path is known.
- [ ] When that same item reaches a terminal `pipeline/loop-execution@1` outcome, a
      durable terminal linkage record exists with the same `item_id` / real
      `pipeline_run_id` (and events path when known) plus the terminal outcome, so audit
      can join supervisor and advance evidence without guessing.
- [ ] The `pipeline/loop-execution@1` response evidence's `pipeline_run_id` equals the
      real advance run-store directory basename when that store exists — not only a
      synthetic `pipeline-loop-<loop-run-id>-<item-id>` string.
- [ ] A harness following only loop supervisor events can discover the active item's
      advance `events.jsonl` path from those events/fields alone and read stage-level
      progress (`stage_start`, `review_verdict`, …) without parsing terminal prose or
      scanning every run directory by mtime.
- [ ] When no advance run store can be established (dispatch fails before init), linkage
      is still terminal-safe (failed/abandoned outcome recorded) and does not invent a
      fake path that points at a non-existent directory as if it were real.
- [ ] Unit tests with injected dispatch / run-store seams cover: (1) start linkage when
      the run store is known, (2) end linkage with outcome + same ids, (3) real
      `pipeline_run_id` in the evidence pointer when a store exists, (4) no sole reliance
      on synthetic ids in that case. At least one regression fails against today's
      synthetic-only evidence without the fix.
- [ ] `npm run ci` is green (core tests, `build.mjs --check` mirror in sync, install
      smoke, `openspec validate --all`).

## Capabilities

### New Capabilities

- `loop-dispatch-advance-linkage`: durable join between a loop supervisor item dispatch
  and the per-item advance run store — start and terminal linkage events/fields
  (`item_id`, real `pipeline_run_id`, absolute events path when known, terminal outcome
  on end), and the rule that synthetic `pipeline-loop-…` ids are not the only join key
  when a real run store exists.

### Modified Capabilities

- `pipeline-loop-facade`: the `pipeline/loop-execution@1` evidence pointer's
  `pipeline_run_id` is defined as the real advance run-store id when that store exists;
  optional absolute events path may be carried on the pointer for consumer convenience.
- `durable-loop-supervisor`: the supervisor's durable event trail for a dispatched item
  includes advance-run linkage at start (when known) and terminal linkage at end, not
  only coarse `loop_item_started` / transition events.

## Impact

- `core/scripts/pipeline.ts` — `realDispatchItem` (and related pure helpers) must resolve
  or pin the real advance run-store id / events path and return them in
  `LoopEvidencePointer` instead of fabricating `pipeline-loop-…` as the only id.
- `core/scripts/loop-execution-contract.ts` — evidence pointer shape may gain an optional
  absolute events path field; `pipeline_run_id` semantics documented as the real store id
  when present.
- `core/scripts/loop/supervisor.ts` — emit durable start/end linkage events (or enrich
  existing item events) so harnesses following the loop run directory can multiplex onto
  the active advance `events.jsonl`.
- Possible reuse of the existing pin/`--run-id` pattern from detached launch
  (`run-directory-layout` / detached launcher) so the parent knows the run id at spawn
  time without polling — design will choose among pin-before-spawn vs discover-after-init.
- `core/test/` — new/extended unit tests with injected dispatch and run-store fakes;
  no real network/git/subprocess in unit tests.
- `plugin/` — regenerated mirror if `core/` changes (`node scripts/build.mjs`).
- Out of scope: async multi-detach supervisor redesign; skill text alone (#668); merge or
  auto-merge; changing host-local lock/ownership model.
