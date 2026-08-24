## Context

See `proposal.md` for why. Current law and code:

- Bundled `ship-stage-watch.sh` follow mode is
  `tail -n 0 -F "$events_file" | material-filter --until-ship-terminal | emit`
  under `set -o pipefail`. `--until-ship-terminal` stops only on
  `ship_phase` `complete`/`completed`. Loop `events.jsonl` never carries
  that event. `loop_run_superseded` is optional material, so the filter
  prints it and then waits.
- `tail -F` does not exit when the writer is gone. Under `pipefail`,
  bash waits for every pipeline member. Even if the filter exits, a
  silent `tail -F` can keep the watcher alive. That is the v1.40.0 hang.
- Tugboat `attach_train_stage_watch` runs once after train start, then
  `wait "$train_pid"`. `extract_loop_run_handoff_events` returns the
  **first** absolute `events` path. A later handoff is ignored.
- After train, Tugboat may kill the pid-file. It does not reap leftover
  pid-file watches at the **next** ship start. `nohup` watchers survive a
  dead composer.
- Site: v1.40.0 watcher on `loop-0c17cdaa` after `[loop_run_superseded]`
  21:19Z; live train `loop-9d33dc88`; zero later `material-*` sends.

**Class vs site (engine-dogfood bar):**

1. **Class vs site.** The site is one v1.40.0 ship whose watch stayed on
   a superseded loop file. The class is: any exact-run observer bound to
   one `events.jsonl` MUST end follow on that stream’s identity-terminal
   (not a different stream’s terminal). Any composer that attaches that
   observer to a live train MUST re-bind when the live handoff identity
   changes while train is still running. Leftover pid-file watches MUST
   be reaped at the next ship start for that milestone.
2. **Shared surfaces.** Identity-terminal kinds live with the shared
   material filter (`host-neutral-progress-notify`). Re-bind and pid-file
   reap live in `tugboat-thin-ship`. Tests bind watcher follow-exit to
   `loop_run_superseded` and Tugboat re-attach to a second distinct
   stderr handoff. A path-local `ship-stage-watch.sh` comment without
   those gates is a mole.
3. **Next identical fault.** A later watch that `tail -F` after
   `loop_run_superseded` fails the follow-exit test. A later Tugboat that
   attaches once and ignores a second handoff fails the re-attach
   fixture. A leftover live pid-file at ship start fails the reap test.
   No new mole issue for the same class.

## Goals / Non-Goals

**Goals:**

- Watch follow exits after emitting loop identity-terminal.
- Tugboat re-binds `--events-file` to a new distinct live handoff while
  train is still running.
- Documented idle bound forces exit on a terminal or silent superseded
  file if the primary stop did not.
- Next ship start reaps leftover pid-file watches for that milestone.
- Tests fail on the v1.40.0 hang and the one-shot attach.

**Non-Goals:**

- Host-global latest-run discovery or `--milestone` / `--since` on the
  bundled watch.
- Failing the ship because watch notify is down.
- Changing loop `--new-run` / `markRunSuperseded` itself.
- Expanding `pipeline loop logs` until-terminal in this change (that
  command already exits on `loop_run_stopped`, which precedes
  `loop_run_superseded`).
- Killing every `ship-stage-watch` on the host.

## Decisions

### 1. Watcher exits; it does not discover the next run

**Choice:** Bundled `ship-stage-watch.sh` stays `--events-file` only. On
loop identity-terminal it emits the line and exits 0. Tugboat owns
re-bind from this train’s stderr `loop_run_handoff` lines (same extract
path as initial attach). The watcher SHALL NOT glob latest runs or parse
`superseded_by` into a new file path.

**Why:** Living exact-run law forbids latest discovery. `superseded_by`
is a run id, not an events path. The live absolute path is the handoff
`events` field train already writes on stderr.

**Alternatives considered:**

- Watcher follows `superseded_by` under the loop store → rejected.
  Reconstructing `<state-home>/runs/<id>/events.jsonl` is discovery and
  drifts when state-home resolution changes.
- Watcher tails train.stderr itself → rejected. That mixes composer
  attach into the exact-file observer and still needs Tugboat to spawn
  the first watch.

### 2. Shared identity-terminal, not `--until-ship-terminal` on a loop file

**Choice:** Loop follow SHALL stop on the first of `loop_run_superseded`,
`loop_run_complete`, or `loop_run_stopped`. Ship-stream follow SHALL
still stop on `ship_phase` complete/completed. The shared material
filter (or an equivalent watch-owned parser of the same kinds) SHALL
classify those terminals. The watch SHALL still emit the terminal
material line before exit.

**Why:** v1.40.0 used the wrong stream’s terminal. Classifying kinds in
the shared filter keeps host skills, Tugboat, and the watch aligned.
A shell `grep` of one-liners would drift from `LOOP_*_KINDS`.

**Alternatives considered:**

- Keep `--until-ship-terminal` and grep `[loop_run_superseded]` in the
  emit loop → rejected as site-only. A later consumer of the same filter
  flag would still hang.
- Rename `--until-ship-terminal` in place to mean every stream →
  rejected. Ship-stream callers would then exit on a loop kind they
  never see, which is harmless, but the flag name would lie and hide
  the class. Prefer an identity-terminal stop (new flag or documented
  expansion) plus watch-owned exit so the process cannot outlive the
  filter.

### 3. Do not rely on `tail -F` SIGPIPE under `pipefail`

**Choice:** Follow MUST own stop. The watch SHALL kill or otherwise
reap its follow child (`tail -F` or equivalent) when identity-terminal
or idle-exit fires. Observable contract: the `ship-stage-watch.sh`
process exits. Implementation MAY use a coproc, GNU `tail --pid`, a
filter follow mode, or a read loop with idle. It SHALL NOT assume
`tail -F | filter | emit` under `pipefail` ends because the filter
exited while the file is silent.

**Why:** That pipeline is the hang even after filter-side terminal
detection. The v1.40.0 process stayed in `tail -F`.

**Alternatives considered:**

- Drop `pipefail` for that pipe → rejected. Masks other filter failures.
- Wait for SIGPIPE on the next `tail` write → rejected. A dead file
  never writes.

### 4. Idle exit is a backup on a terminal or silent superseded file, not on a live slow train

**Choice:** Default idle bound is 30 seconds with no new parsed line
**after** identity-terminal was seen, or when the bound file has already
been classified terminal. Tests MAY inject a shorter bound (env such as
`SHIP_STAGE_WATCH_IDLE_SECS`). Idle SHALL NOT kill a live run that has
not emitted identity-terminal (review/CI gaps are longer than 30s).
Tugboat re-bind on a **new distinct handoff** is the miss-path if the
watcher never saw the terminal line.

**Why:** The issue asks for bounded inactivity on a superseded run.
Applying idle to every quiet live stream would drop Buzz during long
stages.

**Alternatives considered:**

- Always-on idle for any quiet file → rejected. False exits on live
  trains.
- Idle-only, no identity-terminal → rejected. 30s of silence after
  supersede is worse than immediate exit on the event.

### 5. Tugboat re-binds on a distinct live handoff; it does not respawn the same dead file

**Choice:** Keep first-handoff attach so watch starts as soon as the
first `events` path is known. While `train_pid` is live, Tugboat SHALL
poll this train’s stderr for a `loop_run_handoff` whose absolute
`events` path differs from the currently bound path. On a distinct
path it SHALL reap the prior watch if still live and spawn
`--events-file` on the new path. If the prior watch has already
exited, it SHALL spawn only when that distinct newer path exists. It
SHALL NOT immediately respawn the same path after identity-terminal
exit (that file is dead). Watch spawn failure SHALL NOT fail the ship.

`extract_loop_run_handoff_events` may stay “first path” for the initial
waiter. Re-bind SHALL select a later distinct path (last distinct
absolute `events` on this stderr, or any path ≠ bound path).

**Why:** v1.40.0 attached once to `loop-0c17cdaa`. Train later handed
off `loop-9d33dc88` on the same stderr. First-only extract is the
composer site. Killing a still-alive stale watch on identity change
covers the case where the old process did not exit.

**Alternatives considered:**

- Change extract to last-only and attach once → rejected. Attach would
  wait until the final run, missing early stage posts.
- Background loop that respawns the same `--events-file` whenever the
  pid dies → rejected. That re-follows the dead superseded file.
- Fail train when watch dies → rejected. Notify is observational.

### 6. Pid-file reap at next ship start is scoped to this milestone RUN_DIR

**Choice:** After this ship acquires its RUN_DIR lock, if
`stage-watch.pid` names a live pid, Tugboat SHALL kill that pid and
remove the file before the new train attach. Optional parent-pid env
on the watch MAY also exit when the composer is gone. Tugboat SHALL
NOT `pkill -f ship-stage-watch` across the host.

**Why:** Same-milestone relaunch reuses
`$STATE_ROOT/ship-v<version>/stage-watch.pid`. A leftover `nohup`
watch from a dead composer is that file. Other milestones may have
their own live watches.

**Alternatives considered:**

- Host-global pkill → rejected. Concurrent ships would lose notify.
- Reap only after train → rejected. That is current code and still
  leaves PIDs when the composer dies first.

### 7. Regression tests inject the events stream and Tugboat helpers

**Choice:**

- `core/test/ship-stage-watch.test.ts`: spawn follow (not `--once`)
  with an injectable filter, append `loop_run_superseded`, assert the
  process exits within a short timeout and that stdout included the
  terminal line. The test SHALL fail if the process is still alive
  (v1.40.0 `tail -F` hang).
- `core/test/tugboat.test.ts`: extract/run attach helpers. First
  handoff starts watch. Fake watch exits. Second distinct handoff
  while fake train pid is live. Assert a second `--events-file` spawn
  uses the new path. A second fixture writes a live leftover pid-file
  and asserts ship-start reap kills it. Tests SHALL NOT start a live
  train, messenger, or ship.

**Why:** Issue requires an injectable-seam supersede test. Tugboat
already extracts helpers this way (`#1184`).

**Alternatives considered:**

- End-to-end live ship with Buzz → rejected. Unit tests inject I/O.
- Source-only regex that `ship-stage-watch.sh` mentions
  `loop_run_superseded` → rejected. That would not fail a hang.

## Risks / Trade-offs

- **[Risk] Re-bind races the second handoff before the first watch
  exits.** → Mitigation: on a distinct new path, reap the old pid then
  spawn. Do not wait forever for the old process if identity changed.
- **[Risk] Multiple advance waves emit many handoffs.** → Mitigation:
  bind to each new distinct absolute `events` path in order. Do not
  glob mtime. Dedup by path so a repeated same-path line does not
  restart watch.
- **[Risk] Idle bound fires on a live slow run.** → Mitigation: idle
  only after identity-terminal (or equivalent classified terminal).
  Tugboat distinct-handoff reap covers a missed terminal line.
- **[Risk] `tail -F` child leaked after parent exit 0.** → Mitigation:
  explicit reap of the follow child in the watch trap; pid-file cleanup
  already on EXIT; Tugboat ship-start reap as backstop.
- **[Risk] Stale installed `~/.local/bin/tugboat` keeps one-shot
  attach.** → Mitigation: extract tests gate the repo sources. Operators
  still refresh the install pack. This change does not kill an in-flight
  v1.40.0 ship.
- **[Trade-off] Watcher stays single-identity.** Operators who run
  `ship-stage-watch` by hand against one file still must restart it
  after supersede. Product path is Tugboat re-bind.

## Migration Plan

1. Land identity-terminal follow-exit, Tugboat distinct-handoff
   re-bind, pid-file reap, and tests on this branch.
2. Merge. Next `Ship milestone` uses repo/candidate Tugboat after
   pack refresh / composer re-exec. An in-flight v1.40.0 watch stays
   inert until that ship ends; do not kill it as the fix.
3. Rollback: revert the watch/Tugboat/filter/test/spec change. Follow
   would again hang after `loop_run_superseded`.

## Open Questions

None. Fail-reason tokens MAY match existing `stage-watch started` /
`stage-watch failed` style; specs name the class, not a single log
string, except where a named log already exists.
