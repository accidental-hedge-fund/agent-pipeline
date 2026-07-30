## Why

Once a loop item is linked to an advance run (`loop_item_advance_linked`), the
loop `events.jsonl` stays quiet while pre-merge does the real work — CI wait,
OpenSpec archive, delta review, auto-fix, and blockers — all of which already
land on the **advance** stream as `gate_result`, `review_verdict`,
`blocker_set`, etc. Hosts that follow only the loop path (or miss the linked
advance file) see minutes of silence, then a sudden terminal
`blocked_needs_human` / finished event. Dogfood `loop-e640995c20b8f046` / advance
`554-2026-07-29T17-23-40-332Z` made this operator-blindness concrete.

Stage-level progress (#611) is a separate surface. This change fills the
**dense sub-steps inside pre-merge** so loop-only follow is sufficient for gate
outcomes without forcing hosts to parse full advance noise.

## What Changes

- While an item’s advance run is linked, the loop supervisor (or a thin mirror
  driven by the supervisor during the child wait) SHALL append **material**
  loop progress events for major pre-merge gate outcomes: CI waiting/passed/failed
  (with classification when available), OpenSpec archive pass/skipped/fail,
  delta review started/approve/needs-attention (blocking count), pre-merge
  auto-fix attempted/success/exhausted, and terminal blocked / advanced-out-of-
  pre-merge reason class.
- Events SHALL carry join keys: `item_id`, `pipeline_run_id`, and preferably the
  absolute advance `events` path already published on `loop_item_advance_linked`.
- Progress events SHALL use **one schema family** compatible with #611’s
  stage-progress surface (typed payloads under a shared progress kind — not a
  second competing progress model).
- Unit tests SHALL cover emit conditions with fake advance/gate outcomes (no
  real network, git, or subprocess).
- Host skill docs SHALL document that loop events carry these material gate
  sub-steps, and that optional advance-stream follow remains available for full
  fidelity (coordinate wording with #684 dual-follow interim if still open).

## Acceptance criteria

- [ ] OpenSpec change defines the loop progress event kind (or shared progress
      payload schema) and scenarios for each required pre-merge gate facet
      (CI, OpenSpec archive, delta review, auto-fix, terminal).
- [ ] While a #554-class item is in pre-merge with advance linkage active, the
      loop run’s `events.jsonl` receives at least one material progress event per
      major gate outcome that occurs — without requiring the host to tail only
      the advance `events.jsonl`.
- [ ] Each mirrored progress event includes `item_id` and `pipeline_run_id`;
      when the absolute advance `events` path is known, it is present on the
      progress payload (or joinable from the prior `loop_item_advance_linked`).
- [ ] Unit tests with injected advance/gate fake outcomes prove emit conditions
      for pass, fail/blocked, skipped, waiting (once, not per poll), delta
      approve vs needs-attention, and auto-fix attempted/success/exhausted.
- [ ] Pure CI poll spam is not mirrored as a new loop event on every poll tick
      (at most one “waiting” entry per continuous wait stretch, then outcome).
- [ ] Host skill (Claude + Codex) docs list the new material progress kinds /
      facets among must-notify or should-notify loop events, and still document
      optional advance-path follow for full fidelity.
- [ ] No change to pre-merge gate logic, review policy, auto-fix bounds, or
      merge behavior — observability only.
- [ ] `npm run ci` is green; `plugin/` regenerated if host docs under `core/` /
      packaging sources require it.

## Capabilities

### New Capabilities
- `loop-pre-merge-gate-sub-events`: while advance linkage is active, mirror
  material pre-merge gate sub-step outcomes onto the durable loop event stream
  using a shared progress event family (joinable to the advance run).

### Modified Capabilities
- `loop-dispatch-advance-linkage`: start linkage remains the handoff that enables
  gate mirroring; progress events join on the same `(item_id, pipeline_run_id)`
  and prefer the same absolute `events` path.
- `loop-skill-orchestration`: material event list and orchestration prose include
  pre-merge gate progress facets so hosts notify on loop-stream gate outcomes
  without requiring advance-only follow.

## Impact

- `core/scripts/loop/supervisor.ts` (and/or a small helper module under
  `core/scripts/loop/`) — during linked advance wait, mirror material advance
  gate outcomes into loop `appendEvent`.
- `core/scripts/loop/types.ts` / event constants — shared progress kind + payload
  typing if kept next to other loop kinds.
- `core/test/` — unit tests with fake advance event streams / gate outcomes.
- `hosts/claude/SKILL.md`, `hosts/codex/SKILL.md` (+ plugin mirror via
  `node scripts/build.mjs`) — material kinds / progress facets + optional
  advance follow note.
- **Out of scope:** implementing full #611 stage table / `--audit` stage column
  (may share the progress envelope); #684 dual-follow packaging (interim);
  changing CI gate, OpenSpec archive, delta review, or auto-fix algorithms;
  auto-merge.
- **Not changing:** pipeline never merges; review rigor; single-host lock scope.
