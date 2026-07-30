## ADDED Requirements

### Requirement: Host loop orchestration SHALL stop all run-scoped follows on terminal in the same turn

Host skill guidance for `pipeline:loop` drive and resume (Claude and Codex) SHALL
require that when a material `loop_run_stopped` event is observed for the followed
loop `run_id`, **or** when the supervisor process for that run exits, the harness
SHALL stop **all** loop event Monitors/follows and **all** advance event
Monitors/follows that were started for that loop run (including dual-follow /
multi-stream follows) **in the same harness turn**. The guidance SHALL NOT
instruct the harness to leave those follows running until the operator requests
a kill. The guidance SHALL NOT require stopping Monitors or follows that are not
scoped to that loop `run_id` or its published advance `run_id`s.

#### Scenario: Same-turn stop on loop_run_stopped

- **WHEN** a harness following a durable loop observes a material
  `loop_run_stopped` event for the active `run_id`
- **THEN** host skill guidance SHALL instruct the harness to stop the loop
  follow and any advance follows for that run in the same turn
- **AND** SHALL NOT require an operator kill step to end those follows

#### Scenario: Same-turn stop on supervisor process exit

- **WHEN** the supervisor process for the followed loop run exits without a
  further need for mid-flight following
- **THEN** host skill guidance SHALL instruct the harness to stop all
  run-scoped loop and advance follows in the same turn

#### Scenario: Unrelated Monitors are out of scope

- **WHEN** the harness stops follows after a terminal loop outcome
- **THEN** the guidance SHALL NOT require killing Monitors for other issues,
  other run ids, or session tools unrelated to that loop run

---

### Requirement: Documented dual-follow patterns SHALL exit the follow process on loop_run_stopped

Documented dual-follow patterns SHALL exit the follow process on
`loop_run_stopped`. Host skill (or packaging) guidance that documents a
dual-follow or multi-stream follow script for loop + advance events SHALL
require that the follow process exits with code 0 after observing
`loop_run_stopped` and after printing a final summary line. The documented
pattern SHALL NOT keep looping indefinitely after terminal observation (for
example, printing `TERMINAL` inside `while true` and continuing without exit).

#### Scenario: Dual-follow script exits after terminal

- **WHEN** an operator or harness runs the documented dual-follow pattern for a
  loop `run_id`
- **AND** a `loop_run_stopped` event is observed on the loop stream
- **THEN** the documented script SHALL exit 0 after a final summary line
- **AND** SHALL NOT continue an infinite follow loop solely after printing a
  terminal marker

---

### Requirement: Final loop summary SHALL report terminal reason and that follows stopped

Final loop summary SHALL report terminal reason and that follows stopped.
Host skill guidance for the final operator summary after a completed or stopped
`pipeline:loop` drive/resume SHALL require that the summary include (1) the run’s
terminal reason (or equivalent stop reason from the terminal event / result JSON)
and (2) an explicit confirmation that run-scoped follows were stopped (e.g.
“follows stopped”).

#### Scenario: Completed-loop summary includes both fields

- **WHEN** a harness prints the final summary after `loop_run_stopped` or
  supervisor exit for a multi-item drive/resume
- **THEN** the summary SHALL include the terminal/stop reason
- **AND** SHALL include confirmation that follows for that run were stopped

---

### Requirement: A drift-guard SHALL fail if stop-on-terminal loop follow guidance is weakened

A drift-guard SHALL fail if stop-on-terminal loop follow guidance is weakened.
The repository’s automated tests (or an install/build check covered by
`npm run ci`) SHALL fail if host skill loop-orchestration guidance drops the
requirement to stop run-scoped follows on `loop_run_stopped` (or supervisor
exit) in the same turn, or if documented dual-follow guidance reintroduces an
infinite post-terminal follow loop as the recommended pattern. The guard SHALL
also fail if the primary documented `pipeline loop logs` follow one-liner claims
unconditional “no auto-exit on terminal” without documenting the until-terminal
default.

#### Scenario: Missing stop-on-terminal language fails the guard

- **WHEN** host skill §4b (or equivalent loop orchestration section) no longer
  requires stopping run-scoped follows on `loop_run_stopped` / supervisor exit
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: Unconditional no-auto-exit one-liner fails the guard

- **WHEN** the primary host skill or command-surface one-liner for
  `pipeline loop logs … --follow` claims “no auto-exit on terminal” without
  documenting until-terminal default-on behavior
- **THEN** the drift-guard test or check SHALL fail

## MODIFIED Requirements

### Requirement: Loop orchestration docs SHALL specify handoff, follow, notify, stop, and summarize

Host skill guidance for `pipeline:loop` drive and resume (Claude and Codex) SHALL specify an ordered harness orchestration protocol:

1. Resolve state-home and start or resume the loop **non-blocking** (so mid-flight
   follow is possible; the loop CLI has no `--detach` yet).
2. Obtain `run_id` and the loop events path **before supervisor completion**, in
   this order of preference: (a) early handoff carrying at least `run_id` and a
   loop events path when present; (b) `--resume <run-id>` or an operator-known id;
   (c) race-safe state-home discovery — snapshot `<state-home>/runs/`, then scan
   every candidate directory (ignore `.init-*` staging) and select **only** a run
   that has `contract.json` + `events.jsonl` and a live lock held by the started
   supervisor pid (covers newly published and pre-existing re-drive). Do **not**
   select the first newly published directory by glob order when lock ownership
   is unknown; keep polling until a lock-owned match appears or the supervisor
   exits. The terminal printed result JSON SHALL be documented as a
   final-summary surface only, not as the sole mid-flight source of `run_id` for
   a newly started drive.
3. Follow the loop event stream (persistent Monitor or host-equivalent follow).
4. Optionally follow an active item’s advance event stream when that advance
   `run_id` is published.
5. Stop following on a terminal loop outcome (including `loop_run_stopped`) or
   supervisor process exit — **in the same harness turn**, stopping all
   run-scoped loop and advance Monitors/follows for that `run_id` without
   waiting for an operator kill.
6. Print a final summary (including `pipeline:loop --audit` or the documented
   summary surface) that includes the terminal/stop reason and confirmation that
   follows were stopped.

#### Scenario: Ordered steps are present in host skill guidance

- **WHEN** an operator reads the loop orchestration section of `hosts/claude/SKILL.md`
  or `hosts/codex/SKILL.md`
- **THEN** the text SHALL list start/resume, handoff/`run_id`+events path, event
  follow, stop on terminal outcome or process exit (same-turn teardown of
  run-scoped follows), and summary/`--audit` as ordered steps

#### Scenario: New drive obtains run_id before completion without early handoff

- **WHEN** a harness starts a new multi-item drive and no early handoff is present
- **THEN** the host skill guidance SHALL instruct non-blocking start plus race-safe
  state-home discovery of the run directory before supervisor exit
- **AND** SHALL NOT instruct relying solely on the terminal result JSON for
  mid-flight event following of that new drive

#### Scenario: Optional item-advance follow is not required before linkage exists

- **WHEN** no advance `run_id` has been published for the active item
- **THEN** the harness SHALL still follow the loop event stream
- **AND** the docs SHALL NOT require a non-existent advance-linkage field

#### Scenario: Stop step requires same-turn teardown

- **WHEN** a terminal loop outcome (`loop_run_stopped`) or supervisor exit occurs
- **THEN** the ordered protocol step for stop SHALL require ending run-scoped
  loop and advance follows in the same turn
- **AND** the subsequent summary step SHALL include terminal reason and follows
  stopped confirmation
