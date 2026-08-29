## REMOVED Requirements

### Requirement: `pipeline:loop` packaging SHALL NOT claim seconds-only runs or forbid Monitor

Host packaging for multi-item drive and resume of `pipeline:loop` SHALL treat the
operation as long-running. Generated Claude command docs, the single-source
operation-surface renderer that produces them, and host skill guidance for drive
and resume SHALL NOT claim that the command “completes in seconds” and SHALL NOT
instruct harnesses that “no background process or Monitor is needed.” Read-only
`--audit` MAY remain documented as a short synchronous mode.

#### Scenario: Generated loop command omits the fast-path falsehood

- **WHEN** `scripts/build.mjs` renders the Claude command for the `loop` operation
- **THEN** the rendered body SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** the rendered body SHALL NOT contain the substring “No background process
  or Monitor needed” (case-insensitive)

#### Scenario: Plugin command mirror matches the long-running classification

- **WHEN** the generated `plugin/pipeline/commands/pipeline:loop.md` is inspected
  after a successful build
- **THEN** it SHALL omit the seconds-only / no-Monitor fast-path phrases
- **AND** it SHALL state that multi-item drive or resume is long-running or requires
  event following

#### Scenario: Audit mode stays synchronous

- **WHEN** host or command docs describe `pipeline:loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume

---

## ADDED Requirements

### Requirement: `pipeline loop` packaging SHALL NOT claim seconds-only runs or forbid Monitor

Host packaging for multi-item drive and resume of `pipeline loop` SHALL treat the
operation as long-running. Host skill guidance for drive and resume SHALL NOT claim
that the command “completes in seconds” and SHALL NOT instruct harnesses that “no
background process or Monitor is needed.” Read-only `--audit` MAY remain documented
as a short synchronous mode. This requirement SHALL NOT depend on generated Claude
command docs or on `plugin/pipeline/commands/pipeline:loop.md`.

#### Scenario: Host loop guidance omits the fast-path falsehood

- **WHEN** the Claude or Codex host SKILL describes `pipeline loop` drive or resume
- **THEN** that guidance SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** SHALL NOT contain the substring “No background process or Monitor needed”
  (case-insensitive)

#### Scenario: Plugin command mirror matches the long-running classification

- **WHEN** `scripts/build.mjs` is run
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:loop.md`
- **AND** long-running or event-follow guidance SHALL live on the host SKILL (or CLI docs), not on a slash-command file

#### Scenario: Audit mode stays synchronous

- **WHEN** host or command docs describe `pipeline loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume

## MODIFIED Requirements

### Requirement: Loop orchestration docs SHALL specify handoff, follow, notify, stop, and summarize

Host skill guidance for `pipeline loop` drive and resume (Claude and Codex) SHALL specify an ordered harness orchestration protocol:

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
6. Print a final summary (including `pipeline loop --audit` or the documented
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

### Requirement: A drift-guard SHALL fail if the seconds-only / no-Monitor loop guidance returns

The repository’s automated tests (or an install/build check covered by `npm run ci`) SHALL fail if host SKILL guidance reintroduces a fast-path claim that `pipeline loop` drive/resume completes in seconds or forbids Monitor, background execution, or event following. This guard SHALL inspect the SKILL/CLI guidance and SHALL NOT depend on `renderClaudeCommand` or a generated per-verb command file.

#### Scenario: Forbidden phrase fails the guard

- **WHEN** a Claude or Codex host SKILL describes `pipeline loop` drive/resume as
  completing in seconds or says “No background process or Monitor needed”
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: True-fast commands remain allowed to use the fast template

- **WHEN** CLI or SKILL guidance describes a true-fast operation such as `status` or `doctor`
- **THEN** the loop drift-guard SHALL NOT fail solely because those operations
  use seconds-only guidance
- **AND** no per-verb command renderer SHALL be required

### Requirement: Loop orchestration docs SHALL treat pre-merge gate progress as material loop events

Host skill guidance for `pipeline loop` drive and resume SHALL list the shared
loop progress event kind used for pre-merge gate sub-steps (default name
`loop_item_progress`, or the single shared progress kind name if renamed to
converge with stage progress) among material loop events that warrant a harness
notification via the host notify map when `domain` is `pre_merge` and `status`
is a definitive outcome (`pass`, `fail`, `approve`, `needs_attention`,
`attempted`, `success`, `exhausted`, `blocked`, `advanced`) or the first
`waiting` for a CI stretch. The guidance SHALL state that these events appear on
the **loop** event stream while advance linkage is active so hosts are not
forced to parse advance-only logs for major gate outcomes. Notify delivery SHALL
use each host's map entry; guidance SHALL NOT hard-require Claude
`PushNotification` on non-Claude hosts.

#### Scenario: Material list includes progress kind

- **WHEN** an operator reads the material-events list in host skill guidance
- **THEN** the list SHALL include the shared progress event kind
  (`loop_item_progress` or the converged shared name)

#### Scenario: Docs state loop stream carries pre-merge gate outcomes

- **WHEN** an operator reads loop orchestration guidance for mid-item progress
- **THEN** the text SHALL state that material pre-merge gate outcomes (CI,
  OpenSpec archive, delta review, auto-fix, terminal blocked/advanced) are
  published on the loop event stream while the item is advance-linked

#### Scenario: First waiting only per CI stretch

- **WHEN** the guidance describes `loop_item_progress` CI `waiting` notifications
- **THEN** it SHALL instruct notifying on the first waiting in a stretch and
  suppressing subsequent identical waiting polls until a definitive outcome

---

### Requirement: Host skill guidance SHALL mandate dual-follow lifecycle after advance linkage

Host skill guidance for `pipeline loop` drive and resume (Claude and Codex) SHALL
require that, once advance linkage is published for an item, the harness follows
both the loop event stream and that item’s advance event stream until a terminal
condition applies. On a new item’s advance linkage, the guidance SHALL instruct
the harness to switch or add follow for the new advance run. On a terminal
advance outcome for the prior item, the guidance SHALL instruct stopping that
prior advance follow. Loop-stream follow SHALL continue until a terminal loop
outcome or supervisor process exit. Preference order for the advance follow
target SHALL be: (1) `pipeline logs <advance-run-id> --events --follow` or
host-packaged equivalent when `pipeline_run_id` is known; (2) absolute `events`
path from the linkage record.

#### Scenario: Skill names preferred advance follow command

- **WHEN** an operator reads §4b.d (or successor) in `hosts/claude/SKILL.md` or
  `hosts/codex/SKILL.md`
- **THEN** the text SHALL show or name `logs … --events --follow` against the
  advance run id as the preferred follow path
- **AND** SHALL accept the absolute advance `events` path from linkage as a
  valid alternative target

#### Scenario: Item switch stops prior advance follow

- **WHEN** a later item publishes a new advance linkage while a prior item’s
  advance follow is active, or the prior item reaches a terminal advance outcome
- **THEN** the guidance SHALL instruct stopping or replacing the prior item’s
  advance follow rather than leaving an unbounded set of stale advance follows

#### Scenario: Loop follow continues across item boundaries

- **WHEN** an item’s advance follow ends after a terminal advance outcome but the
  loop run is still live
- **THEN** the guidance SHALL keep the loop event stream follow active until a
  terminal loop outcome or supervisor exit

---

### Requirement: A drift-guard SHALL fail if post-linkage dual-follow regresses to optional-only wording

Automated tests covered by `npm run ci` SHALL fail if host skill guidance for
`pipeline loop` drive/resume reintroduces optional-only advance follow as the
sole post-linkage instruction (e.g. a §4b.d heading or body that says only
“Optionally follow active item advance events when published” without mandatory
dual-follow language after linkage). The guard MAY be a focused substring or
section assertion against `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md`
(and/or the generated plugin skill mirror). A deliberate demotion after #611 MAY
update the guard in the same change.

#### Scenario: Optional-only post-linkage wording fails the guard

- **WHEN** host skill §4b.d (or successor) describes advance follow after linkage
  only as optional and lacks mandatory dual-follow language
- **THEN** the drift-guard test or check SHALL fail under `npm run ci`

#### Scenario: Pre-linkage optional absence remains allowed

- **WHEN** skill text states that advance follow is not required before linkage
  exists
- **THEN** the dual-follow drift-guard SHALL NOT fail solely because of that
  pre-linkage caveat

### Requirement: Host loop orchestration SHALL stop all run-scoped follows on terminal in the same turn

Host skill guidance for `pipeline loop` drive and resume (Claude and Codex) SHALL
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

### Requirement: Final loop summary SHALL report terminal reason and that follows stopped

Final loop summary SHALL report terminal reason and that follows stopped.
Host skill guidance for the final operator summary after a completed or stopped
`pipeline loop` drive/resume SHALL require that the summary include (1) the run’s
terminal reason (or equivalent stop reason from the terminal event / result JSON)
and (2) an explicit confirmation that run-scoped follows were stopped (e.g.
“follows stopped”).

#### Scenario: Completed-loop summary includes both fields

- **WHEN** a harness prints the final summary after `loop_run_stopped` or
  supervisor exit for a multi-item drive/resume
- **THEN** the summary SHALL include the terminal/stop reason
- **AND** SHALL include confirmation that follows for that run were stopped

---

### Requirement: Loop skill packaging SHALL include Grok in host-notify and dual-follow guidance surfaces

Host skill guidance for `pipeline loop` drive and resume SHALL cover every
operator host that installs pipeline skill packaging for long-running loop
orchestration, including Claude, Codex, and the Grok-consumed path (first-class
`hosts/grok` when present, or the documented Grok substitute). Dual-follow,
material notify, and same-turn stop requirements SHALL apply on the Grok path
using Grok's host map entry, not Claude-only tools.

#### Scenario: Grok-consumed loop section uses host map

- **WHEN** a Grok agent reads loop orchestration §4b (or substitute) on the path
  it loads
- **THEN** the text SHALL require material progress notify via Grok's map entry
- **AND** SHALL retain dual-follow after linkage and same-turn stop on
  `loop_run_stopped`

#### Scenario: Existing Claude and Codex loop contracts remain

- **WHEN** `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` loop sections are
  read after this change
- **THEN** they SHALL still list ordered start/handoff/follow/notify/stop/summary
  steps
- **AND** SHALL still mandate dual-follow after linkage until #611 demotes it
