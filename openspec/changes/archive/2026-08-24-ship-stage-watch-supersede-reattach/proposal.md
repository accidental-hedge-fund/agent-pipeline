## Why

Ship v1.40.0 bound `ship-stage-watch` to one exact loop `events.jsonl`. Train then superseded that run (`loop-0c17cdaa` → `loop-9d33dc88`). The watcher logged `[loop_run_superseded]` at 21:19Z and stayed alive on the dead stream. Buzz got no further `material-*` stage posts even though train kept advancing #1221. Stale watch PIDs also lingered.

## What Changes

- **Class law, not a v1.40.0 mole.** An exact-run ship observer SHALL treat identity-terminal events of the **bound** stream as end-of-follow. For a loop `events.jsonl` those kinds are `loop_run_superseded`, `loop_run_complete`, and `loop_run_stopped`. The observer SHALL emit the terminal line, then **exit**. It SHALL NOT keep `tail -F` on a stream that will not write again. `--until-ship-terminal` (`ship_phase` complete) SHALL NOT be the only stop when the bound file is a loop run.
- **Composer re-bind.** While the parent train is still running, Tugboat SHALL treat watch exit (or a new distinct live `loop_run_handoff` events path on this train’s stderr) as a re-attach. It SHALL spawn bundled `ship-stage-watch.sh --events-file` against the new absolute path. It SHALL NOT attach only at initial train start.
- **Bounded idle exit.** If the bound run is identity-terminal or writes no new events for a documented inactivity bound, the watcher SHALL exit so a re-attach can happen. Silent follow of a dead stream SHALL NOT be the product path.
- **Stale reap.** The next ship start for that milestone SHALL reap a leftover live pid recorded in this ship’s `stage-watch.pid` (or the parent/pid-file contract). The watcher SHALL exit when that parent contract says the composer is gone. Host-global kill of every `ship-stage-watch` SHALL NOT be required.
- **Tests bite.** An injectable-seam unit test SHALL feed `loop_run_superseded` and fail if the watcher stays alive. A Tugboat fixture SHALL fail if train keeps running, a new handoff appears, and watch is not re-bound to that new absolute `events` path.

**BREAKING** for fixtures that assume follow mode never exits on loop identity-terminal, or that Tugboat attaches stage-watch once per train and never again.

Non-goals: host-global latest-run discovery; restoring `--milestone` / `--since` on the bundled watch; failing the ship because notify is down; merging inside advance/loop; LLM-first recovery; changing loop supersession itself.

## Acceptance criteria

- [ ] After `ship-stage-watch` follow mode observes `loop_run_superseded` (or `loop_run_complete` / `loop_run_stopped`) on the bound events file, the process exits. It does not stay alive on that file.
- [ ] The watcher still emits the identity-terminal material line (Buzz still sees `[loop_run_superseded]` / complete / stopped) before that exit.
- [ ] While Tugboat’s train pid is still live, a new distinct `loop_run_handoff` absolute `events` path on this train’s stderr causes a new `--events-file` spawn against that path after the prior watch has exited or been reaped. Stage posts after supersede come from the new run, not the dead one.
- [ ] A documented inactivity bound on a superseded or otherwise silent bound file causes the same completed-path exit (so re-attach can happen even if one terminal line is missed).
- [ ] The next ship start for that milestone reaps a leftover live pid in this ship’s `stage-watch.pid` (or the parent contract). A prior-ship watcher does not keep posting from a dead loop after the new ship starts.
- [ ] `--events-file` stays one absolute path. The watcher and Tugboat still do not glob host-global run directories or pick newest `events.jsonl` by mtime.
- [ ] Watch spawn / re-attach failure does not fail the ship. Notify stays observational.
- [ ] A unit test feeds a follow-mode events stream that includes `loop_run_superseded` and fails if the watcher process is still alive after a short timeout. A Tugboat helper fixture fails if a second live handoff is ignored while train is still running.
- [ ] After any `core/` edit, `plugin/` is regenerated in the same change. `npm run ci` is green.

## Capabilities

### New Capabilities

<!-- None. This extends exact-run notify and Tugboat compose law. -->

### Modified Capabilities

- `host-neutral-progress-notify`: An exact-run ship progress observer bound to one `events.jsonl` SHALL stop follow on that stream’s identity-terminal events (`loop_run_superseded`, `loop_run_complete`, `loop_run_stopped` for a loop file). It SHALL exit rather than wait for `ship_phase` complete on a loop file. Bounded inactivity on a terminal or silent bound file SHALL also end follow. Latest-run discovery SHALL remain forbidden.
- `tugboat-thin-ship`: Tugboat SHALL re-bind train stage-watch to a new live `loop_run_handoff` `events` path while train is still running after the prior watch exits (or is reaped) due to supersede/complete. Next ship start SHALL reap leftover pid-file watches for this milestone. Existing `--events-file` argv, sibling default binary, material-filter presentation, and observational notify SHALL remain in force.

## Impact

- **Watcher:** `examples/supervisor/shell/ship-stage-watch.sh` follow mode (`tail -F` piped through `material-filter --until-ship-terminal` today). Exit on loop identity-terminal and bounded idle. Keep `--events-file` only.
- **Shared filter:** `core/scripts/material-filter.ts` terminal detection used by the watch. Loop identity-terminal MUST stop a loop follow; `ship_phase` complete remains the ship-stream terminal.
- **Tugboat:** `examples/supervisor/shell/tugboat.sh` `attach_train_stage_watch` / `start_train_stage_watch` / `extract_loop_run_handoff_events`. Re-attach on a later distinct handoff; reap pid-file at ship start. `extract` currently returns the first handoff — re-bind needs the live (latest distinct) path.
- **Tests:** `core/test/ship-stage-watch.test.ts` follow-mode supersede exit. `core/test/tugboat.test.ts` re-attach + leftover pid reap. Material-filter unit coverage if terminal kinds move into the filter.
- **Docs / skills:** ship-milestone / Hermes watch notes: follow exits on loop identity-terminal; Tugboat re-binds. Do not teach latest-run glob.
- **Depends on:** living `loop-early-run-handoff` (`events` absolute path), `integrated-train-mode` (handoff on train stderr, not `--json` stdout), `supervisor-ship-notify` (observational).
- **Does not:** glob latest runs; fail the ship on watch death; merge inside advance/loop.
- **Evidence:** v1.40.0 `stage-watch.log` ended at `[loop_run_superseded]` 21:19Z; train then advanced #1221 with zero `material-*` sends after that time; one watcher still followed superseded `loop-0c17cdaa` while live train was `loop-9d33dc88`.
