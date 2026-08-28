# host-neutral-progress-notify Specification

## Purpose
TBD - created by archiving change host-neutral-progress-notify. Update Purpose after archive.

## Requirements

### Requirement: Host skill overlays SHALL document a host notify map for material progress

Host skill packaging for advance and loop orchestration SHALL document a **host
notify map** that names how each supported operator host surfaces material
stage/loop progress to the human. The map SHALL include at least:

- **Claude:** Monitor (or equivalent follow) on the material event stream, plus
  `PushNotification` (or successor Claude push surface) for material one-liners.
- **Grok:** host `monitor` (or equivalent) on the material event stream such
  that each material stdout line becomes a chat notification; Grok packaging
  SHALL NOT hard-require Claude `PushNotification`.
- **Codex:** concise chat/status updates on material events with an explicit
  must-notify mapping; Codex packaging SHALL NOT name Claude-only tools as
  required.

The shared orchestration contract SHALL state that the harness **must notify
via the host map** on material events, rather than requiring a single host's
tool in prose consumed by other hosts.

#### Scenario: Claude map names PushNotification for that host only

- **WHEN** an operator reads the host notify map in `hosts/claude/SKILL.md`
- **THEN** the Claude entry SHALL name Monitor follow plus `PushNotification`
  (or documented Claude successor) for material progress
- **AND** the shared mandatory step language SHALL be notify-via-host-map rather
  than implying every host has `PushNotification`

#### Scenario: Grok map never requires PushNotification

- **WHEN** an operator or agent reads the skill path Grok installs or the Grok
  host overlay / Grok substitute for §4 / §4b
- **THEN** the text SHALL name host `monitor` (or equivalent) with material-only
  lines as the notify surface
- **AND** SHALL NOT hard-require Claude `PushNotification` for Grok

#### Scenario: Codex map uses chat/status without Claude tool names

- **WHEN** an operator reads the host notify map in `hosts/codex/SKILL.md`
- **THEN** the Codex entry SHALL require concise chat or status updates for
  material events
- **AND** SHALL NOT list `PushNotification` as a required tool

---

### Requirement: A shared material filter SHALL select skill-material events from events.jsonl

The repository SHALL provide a shared material filter (a skill/core script
and/or documented composition of `logs … --events --follow` with that filter,
and optionally an engine `--material` flag reusing the same logic) that reads
advance, loop, or train `events.jsonl` lines and emits only skill-material progress
lines suitable for host notify.

For **advance** streams, the material set SHALL include at least: `run_start`,
`stage_start`, `stage_complete`, `pr_created`, `pr_updated`, `review_verdict`,
`gate_result`, `blocker_set`, `blocker_cleared`, and `run_complete`.

For **loop** streams, the material set SHALL include at least:
`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
`loop_item_advance_linked`, item-advance finished / equivalent terminal
item-advance linkage kinds already named in host skill text,
`loop_item_stage_progress`, material `loop_item_progress`, and
`loop_run_stopped`.

For **train** streams, the material set SHALL include at least: `run_start`,
`train_work_list_resolved`, `train_wave_started`, `train_loop_linked`,
`train_item_started`, `train_item_completed`, `train_pr_created`,
`train_merge_attempted`, `train_merge_proven`, `train_merge_integrated`,
`train_sibling_halted`, `train_wave_ended`, and `run_complete`.

The filter SHALL suppress notify spam for: repeated identical CI polling /
`pre_merge.advancePolling`-style bursts after the first material gate event in
a burst; repeated CI `partial` and OpenSpec `skipped` outcomes; non-first CI
`waiting` polls in a `loop_item_progress` stretch; and non-listed heartbeat or
accounting kinds.

The complete unfiltered `events.jsonl` evidence stream SHALL remain unchanged;
the filter is an observation/notify layer only.

#### Scenario: Advance material kinds pass the filter

- **WHEN** the material filter is applied to an advance `events.jsonl` feed that
  contains `run_start`, `stage_start`, `stage_complete`, `pr_created`,
  `review_verdict`, `gate_result`, `blocker_set`, and `run_complete` among noise
- **THEN** those material kinds SHALL appear in the filter output
- **AND** non-listed heartbeat/accounting lines SHALL NOT appear

#### Scenario: Loop material kinds pass the filter

- **WHEN** the material filter is applied to a loop `events.jsonl` feed that
  contains `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
  `loop_item_advance_linked`, `loop_item_stage_progress`, material
  `loop_item_progress`, and `loop_run_stopped` among noise
- **THEN** those material kinds SHALL appear in the filter output

#### Scenario: Train material kinds pass the filter

- **WHEN** the material filter is applied to a train `events.jsonl` feed that
  contains `run_start`, `train_work_list_resolved`, `train_wave_started`,
  `train_loop_linked`, `train_item_started`, `train_item_completed`,
  `train_pr_created`, `train_merge_attempted`, `train_merge_proven`,
  `train_merge_integrated`, `train_sibling_halted`, `train_wave_ended`, and
  `run_complete` among noise
- **THEN** those material kinds SHALL appear in the filter output
- **AND** non-listed heartbeat, accounting, or raw child-engine lines SHALL NOT appear

#### Scenario: CI partial and repeated waiting are suppressed

- **WHEN** the material filter sees repeated identical CI `partial` lines,
  OpenSpec `skipped` spam, or multiple CI `waiting` polls in one stretch
- **THEN** it SHALL suppress the repeated spam
- **AND** SHALL still emit the first material waiting (when that rule applies)
  and definitive gate/progress outcomes

#### Scenario: Raw events.jsonl remains complete

- **WHEN** a run appends events to `events.jsonl`
- **THEN** the material filter SHALL NOT remove or rewrite lines in the run
  store file
- **AND** unfiltered `pipeline logs … --events` SHALL still show the full stream

### Requirement: Skill §4 and §4b progress notify SHALL be host-parameterized

Host skill §4 (single-issue advance orchestration) and §4b (durable loop orchestration) SHALL prescribe a mandatory progress-notify step that refers to the **host notify map** and the **shared material filter**, not an unconditional hard-require of Claude `PushNotification` in prose that non-Claude hosts also consume. Claude's host file MAY still document `PushNotification` as Claude's map entry. Dual-follow after advance linkage SHALL remain required (until #611 demotes it per existing living specs), and the material filter SHALL apply to both the loop stream and the linked advance stream.

#### Scenario: Shared notify step is host-map based

- **WHEN** §4 or §4b describes the mandatory user-visible progress step
- **THEN** the guidance SHALL require notifying via the host map on material
  filter output
- **AND** non-Claude host files SHALL NOT be forced to call `PushNotification`

#### Scenario: Dual-follow uses material filter on both streams

- **WHEN** dual-follow is armed after `loop_item_advance_linked` (or equivalent)
- **THEN** host guidance SHALL apply the material filter (or equivalent
  material-only notify rules) to both the loop stream and the linked advance
  stream
- **AND** SHALL NOT require dual raw unfiltered JSONL notify streams as the
  preferred path

#### Scenario: Claude host retains PushNotification as its map entry

- **WHEN** `hosts/claude/SKILL.md` §4 / §4b notify subsections are read
- **THEN** they MAY name `PushNotification` for Claude
- **AND** SHALL still align material kinds with the shared material filter

---

### Requirement: Grok-consumed packaging SHALL not teach Claude-only PushNotification as required

The skill packaging path that Grok agents load (first-class `hosts/grok` when install supports it, or the installed/symlink path Grok actually uses plus an explicit Grok §4/§4b substitute) SHALL prescribe Grok's host `monitor` + material filter for progress notify. That path SHALL NOT instruct Grok agents that Claude `PushNotification` is required for material stage or loop bubbles. Coordination with first-class `--host grok` install (#731) is allowed; until that lands, the documented substitute on the path Grok consumes SHALL be sufficient.

#### Scenario: Grok path documents monitor + material filter

- **WHEN** a Grok agent follows installed skill guidance for `/pipeline` or
  `/pipeline:loop` progress notify
- **THEN** the guidance SHALL name host `monitor` (or Grok-equivalent) on a
  material-filtered event stream
- **AND** SHALL NOT state that `PushNotification` is required on Grok

#### Scenario: Symlink or Claude overlay consumers get an explicit Grok substitute when no hosts/grok exists

- **WHEN** Grok still installs or symlinks the Claude skill file because
  first-class `--host grok` is unavailable
- **THEN** that consumed file or an immediately adjacent Grok substitute
  section SHALL override Claude-only notify for Grok hosts
- **AND** SHALL name the material filter composition

---

### Requirement: Progress notify SHALL re-arm until terminal and SHALL cross-link related issues

Host skill progress-follow guidance SHALL instruct harnesses to re-arm material
notify follow after wait cancellation or equivalent follow interruption until
`run_complete` (advance) or `loop_run_stopped` (loop). The guidance SHALL
explicitly cross-link wait-cancel re-attach work as #725 (or documented
successor) and denser loop stage progress as #611 (or documented successor)
when discussing dual-follow density. This capability SHALL NOT claim to replace
#725 or #611.

#### Scenario: Re-arm until terminal is documented

- **WHEN** a host follow/monitor is cancelled mid-run before terminal
- **THEN** skill guidance SHALL instruct re-arming material follow until
  `run_complete` or `loop_run_stopped`
- **AND** SHALL point full re-attach semantics to #725 or successor

#### Scenario: Dual-follow density points to #611

- **WHEN** skill text explains why dual-follow remains mandatory for mid-item
  stage progress
- **THEN** it SHALL cross-link #611 (or successor) and SHALL NOT claim this
  notify packaging change alone makes loop-only follow sufficient

---

### Requirement: Progress notify SHALL NOT gate stages or introduce a push microservice

Material progress notify SHALL remain a host-skill observation concern. The
pipeline engine SHALL NOT gate stage transitions, review, or deploy-ready on
whether a human received a notification bubble. This change SHALL NOT introduce
a pipeline-owned push, Slack, or Discord notification microservice as the
default notify path. Structured `events.jsonl` SHALL remain the notify source of
truth.

#### Scenario: No delivery-gated stages

- **WHEN** a material event is written to `events.jsonl`
- **THEN** stage advancement and gates SHALL proceed without requiring proof
  that a host notification was delivered

#### Scenario: No default push microservice

- **WHEN** host packaging describes progress notify
- **THEN** it SHALL use host-local surfaces (Monitor/PushNotification, Grok
  monitor, Codex chat) fed by `events.jsonl`
- **AND** SHALL NOT require a pipeline-owned external push service for default
  operation

### Requirement: External ship progress SHALL follow exact run identities

A channel adapter that reports `pipeline ship` progress SHALL read the typed
ship status and the exact train, loop, or advance event paths recorded by that
ship run. It SHALL apply the shared material filter. It SHALL NOT infer
ownership from a host-global latest-run directory, process start time, issue
number alone, PR title search, or unrelated events.

#### Scenario: Concurrent unrelated run is excluded

- **WHEN** an unrelated Pipeline run emits material events while a ship is
  active
- **THEN** the ship adapter SHALL report only events from run identities stored
  by that ship
- **AND** no unrelated event SHALL appear in the ship's channel thread

#### Scenario: Notification replay uses the exact run cursor

- **WHEN** notification delivery fails and later recovers
- **THEN** the adapter MAY replay missed material events from the exact run
  cursor
- **AND** delivery failure SHALL NOT stop, advance, or fail the ship

---

### Requirement: Drift-guards SHALL protect host notify maps and material kind alignment

Automated tests covered by `npm run ci` SHALL fail if:

1. The Grok-consumed skill path hard-requires Claude `PushNotification` without
   a Grok host-map substitute (`monitor` or documented equivalent).
2. Host skill material kind lists used for notify drift from the shared material
   filter's kind set (or shared single-source constant) for the required advance,
   loop, and train kinds.
3. Claude host packaging loses its material notify map entry without an
   intentional replacement surface.

#### Scenario: Claude-only tool on Grok path fails the guard

- **WHEN** the Grok-consumed skill path requires `PushNotification` and provides
  no Grok `monitor` / host-map substitute
- **THEN** the drift-guard test or check SHALL fail under `npm run ci`

#### Scenario: Material kind list drift fails the guard

- **WHEN** host skill §4 / §4b material kind lists omit a required shared-filter
  kind or the filter drops a kind still required by the skill contract
- **THEN** the drift-guard or unit tests SHALL fail under `npm run ci`

#### Scenario: Train material kind list drift fails the guard

- **WHEN** host skill train-notify kind lists omit a required train material
  kind or the shared filter drops a train kind still required by the skill
  contract
- **THEN** the drift-guard or unit tests SHALL fail under `npm run ci`

#### Scenario: Claude map regression fails the guard

- **WHEN** `hosts/claude/SKILL.md` no longer documents a material progress notify
  surface for advance orchestration
- **THEN** the drift-guard test or check SHALL fail under `npm run ci`

### Requirement: Material-progress notify mapping SHALL be declared on the outer-host manifest

The host notify map for material stage/loop progress SHALL be represented as the outer-host
manifest's material-progress notification capability (or an equivalent field consumed from that
manifest). Shared orchestration SHALL select the notify surface from the active outer host's
declared mapping or its declared unsupported fallback, not by host-name conditionals in shared
orchestration modules.

Existing host-specific surfaces (Claude Monitor + PushNotification, Grok monitor material lines,
Codex chat/status) remain valid **values** of the declared mapping; they MUST NOT be the only
extension mechanism via shared `if host == …` branches.

#### Scenario: Shared orchestration reads notify capability from the manifest

- **WHEN** shared advance or loop orchestration requires material progress notification
- **THEN** it SHALL use the active outer host's declared material-progress notify mapping or
  fallback
- **AND** SHALL NOT require editing shared orchestration host-name switches to support a new
  host's notify surface

#### Scenario: Host without rich notify uses portable fallback

- **WHEN** an outer host declares material-progress notify unsupported or limited to portable
  observation
- **THEN** the declared fallback SHALL use stdout and/or filtered `events.jsonl` material lines
- **AND** shared orchestration SHALL NOT hard-require Claude `PushNotification` for that host

### Requirement: Host ship phrase SHALL exec the Pipeline ship CLI

Host skills for Hermes, OpenClaw, Claude, Codex, Grok, omp, and OpenCode SHALL map operator phrase `Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`. If the CLI is blocking, the host MAY detach one process. Status and stop SHALL read `pipeline ship status` / the Pipeline ship ledger. Notify SHALL fire on ship phase transitions, item transitions, and terminal failure, using the exact child-run identities stored by that ship. Hosts SHALL NOT notify from a Tugboat-owned state machine as the source of truth.

#### Scenario: Phrase becomes the milestone CLI

- **WHEN** an operator says `Ship milestone v1.39.3` on a configured host
- **THEN** the host SHALL exec `pipeline ship --milestone v1.39.3`
- **AND** it SHALL NOT start Tugboat as the ship owner

#### Scenario: Notify follows the ship ledger

- **WHEN** the ship ledger advances from train to release, or an item merges, or the ship fails
- **THEN** the host notify path SHALL emit a material event for that transition or failure
- **AND** the event SHALL name the ship milestone and the exact child-run identity
- **AND** it SHALL NOT infer the ship from a host-global latest-run directory

### Requirement: Hermes SHALL re-invoke the same ship command after a non-human failure

On notify of a non-human ship failure, Hermes SHALL re-invoke the same `pipeline ship --milestone …` argv and no other recoverer. Hermes SHALL NOT classify the failure, delete a run directory, wait a cooldown, or invent `pipeline single` / `pipeline loop`. If ship status reports human authority, Hermes SHALL stop and report that state.

#### Scenario: Non-human failure re-invokes ship

- **WHEN** Hermes receives a non-human failure notify for milestone `v1.39.3`
- **THEN** it SHALL exec `pipeline ship --milestone v1.39.3` again
- **AND** it SHALL NOT classify, janitor a run dir, or invoke `single` / `loop`

#### Scenario: Human authority stops Hermes

- **WHEN** `pipeline ship status` reports a human-authority stop
- **THEN** Hermes SHALL stop and report that human-authority state
- **AND** it SHALL NOT re-invoke ship

### Requirement: Ship progress adapters SHALL present an executable installed material-filter without requiring host env

A channel adapter that applies the shared material filter to `pipeline ship` progress SHALL receive an executable installed `material-filter.mjs` in spawn environment from the pin/host skill install tree (`<skillDir>/scripts/material-filter.mjs` as written by `install.mjs` / `engine-promote`). Host supervisor env remaining unset SHALL NOT be required for that spawn to exec the filter. `engine-promote` SHALL NOT be required to write supervisor env for this spawn to work. An operator-set `PIPELINE_MATERIAL_FILTER` SHALL remain an override and SHALL NOT be overwritten by the adapter. Exact-run `--events-file` identity and observational notify SHALL remain in force.

#### Scenario: Installed filter is presented when supervisor env is unset

- **WHEN** a ship progress adapter spawns bundled `ship-stage-watch.sh --events-file` for a live ship run
- **AND** host supervisor env does not set `PIPELINE_MATERIAL_FILTER`
- **AND** `install.mjs` / `engine-promote` has written an executable `<skillDir>/scripts/material-filter.mjs`
- **THEN** the spawn environment SHALL present that executable to the watch
- **AND** the watch SHALL NOT depend on a leftover PATH name `material-filter.mjs`

#### Scenario: Promote does not have to write supervisor env

- **WHEN** `engine-promote --host all` updates host skill trees and does not write `~/.config/pipeline-supervisor/env`
- **THEN** the next ship progress watch spawn SHALL still present the installed filter from the skill tree
- **AND** a missing supervisor-env assignment SHALL NOT be the owner of filter discovery

#### Scenario: Operator override is preserved

- **WHEN** the operator has set `PIPELINE_MATERIAL_FILTER` to a non-empty path
- **AND** a ship progress adapter spawns the material watch
- **THEN** the adapter SHALL NOT overwrite that value

### Requirement: Ship progress adapters SHALL present Buzz credential vars into notify children

A channel adapter that reports `pipeline ship` progress through `ship-notify` SHALL present `BUZZ_CREDENTIALS_FILE`, `BUZZ_RELAY_URL`, and `BUZZ_CHANNEL` into that helper and into the bundled stage-watch child when those values are set on the supervisor env file or the parent process. When a supervisor-env `BUZZ_CREDENTIALS_FILE` value begins with `~/`, the adapter SHALL expand that prefix to `$HOME/` without sourcing or evaluating the rest of the file, and SHALL present the expanded path rather than the literal `~/` prefix. The adapter SHALL NOT overwrite an operator-set value. The adapter SHALL NOT `source` the whole supervisor env file as the presentation mechanism. Exact-run `--events-file` identity, installed material-filter presentation, and observational notify SHALL remain in force. Silent no-op after a dedupe write, when Buzz is intended (`SHIP_NOTIFY=1` and `BUZZ_BIN` is executable) and credentials cannot be resolved, SHALL NOT be the product path.

#### Scenario: Adapter watch spawn presents parent credentials file

- **WHEN** a ship progress adapter spawns bundled `ship-stage-watch.sh --events-file` for a live ship run
- **AND** the parent process has `BUZZ_CREDENTIALS_FILE` set to a readable file
- **THEN** the spawn environment SHALL include `BUZZ_CREDENTIALS_FILE` set to that same path
- **AND** the adapter SHALL NOT overwrite that value

#### Scenario: Adapter fills unset Buzz vars from supervisor env without sourcing the whole file

- **WHEN** a ship progress adapter starts a ship progress watch
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a readable path
- **THEN** the adapter SHALL present that path to `ship-notify` and to the watch child
- **AND** it SHALL NOT `source` the whole supervisor env file

#### Scenario: Adapter expands a leading-home supervisor-env credentials path

- **WHEN** a ship progress adapter starts a ship progress watch
- **AND** `BUZZ_CREDENTIALS_FILE` is unset in the parent process
- **AND** the supervisor env file sets `BUZZ_CREDENTIALS_FILE` to a path that begins with `~/`
- **AND** `$HOME` plus the remainder of that path is a readable file
- **THEN** the adapter SHALL present the expanded `$HOME/` path to `ship-notify` and to the watch child
- **AND** it SHALL NOT present the literal `~/` prefix
- **AND** it SHALL NOT `source` the whole supervisor env file

#### Scenario: Intended Buzz with missing credentials is not a silent adapter no-op

- **WHEN** `SHIP_NOTIFY` is `1`
- **AND** `BUZZ_BIN` is executable
- **AND** credentials cannot be resolved
- **THEN** the notify path SHALL leave a durable `audit.log` fail or `unconfigured` row
- **AND** ship and train SHALL still continue
- **AND** a missing host supervisor-env assignment SHALL NOT be accepted as a successful empty-channel delivery

### Requirement: Exact-run ship observers SHALL exit on bound-stream identity-terminal

An exact-run ship progress observer bound to one `events.jsonl` SHALL treat identity-terminal events of that bound stream as end-of-follow. For a loop events file, those kinds SHALL be `loop_run_superseded`, `loop_run_complete`, and `loop_run_stopped`. For a ship events file, `ship_phase` with phase `complete` and status `completed` SHALL remain a terminal. The observer SHALL emit the material line for the identity-terminal event it observes, then SHALL exit. The observer SHALL consume that stream with one cursor-aware reader that scans to EOF and continues from the same offset, so an identity-terminal appended after scan EOF is not lost. The observer SHALL NOT remain alive waiting for a terminal kind that the bound file cannot produce. A loop follow SHALL NOT use `ship_phase` complete as its only stop. The observer SHALL still require one absolute `--events-file` (or equivalent exact path). The observer SHALL NOT glob host-global run directories, pick the newest `events.jsonl` by mtime, or reconstruct a successor path from `superseded_by`.

#### Scenario: loop_run_superseded ends follow

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_superseded` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit
- **AND** it SHALL NOT keep following that file

#### Scenario: loop_run_complete ends follow of a superseded or finished run

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_complete` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: loop_run_stopped ends follow

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file receives a `loop_run_stopped` event
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: ship_phase complete still ends a ship-stream follow

- **WHEN** the observer is bound to a ship events file
- **AND** that file receives `ship_phase` with phase `complete` and status `completed`
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

#### Scenario: Follow does not discover a successor run

- **WHEN** the bound loop file records `loop_run_superseded` with a `superseded_by` run id
- **THEN** the observer SHALL exit rather than open another `events.jsonl`
- **AND** it SHALL NOT search host-global run directories for the successor

#### Scenario: Terminal appended during scan-to-follow handoff is not lost

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** `loop_run_superseded` is appended after the initial scan has reached EOF but before follow continues from that scan offset
- **THEN** the observer SHALL emit the material line for that event
- **AND** the observer process SHALL exit

### Requirement: Exact-run ship observers SHALL exit after bounded inactivity on a terminal bound file

An exact-run ship progress observer SHALL exit when the bound file has already produced an identity-terminal event (or has been classified terminal) and no new parsed event arrives within a documented inactivity bound. That bound SHALL be overridable in tests. The observer SHALL NOT apply that inactivity exit to a live bound file that has not produced identity-terminal. Silent follow of a superseded or completed file SHALL NOT be the product path.

#### Scenario: Idle after supersede forces exit

- **WHEN** follow mode has observed `loop_run_superseded` on the bound file
- **AND** no further parsed event arrives within the documented inactivity bound
- **THEN** the observer process SHALL exit
- **AND** it SHALL NOT remain blocked on `tail -F` of that silent file

#### Scenario: Identity-terminal already in the bound file at follow start

- **WHEN** bundled `ship-stage-watch` follow mode is bound to one absolute loop `events.jsonl`
- **AND** that file already contains `loop_run_superseded` (or `loop_run_complete` / `loop_run_stopped`) before the watcher process starts
- **THEN** the observer SHALL emit the material line for that identity-terminal event
- **AND** the observer process SHALL exit
- **AND** it SHALL NOT remain blocked on `tail -n 0 -F` of that silent file
- **AND** it SHALL NOT open a successor `events.jsonl`

#### Scenario: Idle does not kill a live quiet run

- **WHEN** follow mode is bound to a live loop file that has not emitted `loop_run_superseded`, `loop_run_complete`, or `loop_run_stopped`
- **AND** no new event arrives for longer than the inactivity bound
- **THEN** the observer SHALL keep following
- **AND** it SHALL NOT exit solely because the live run is quiet

### Requirement: Bound-stream identity-terminal follow-exit SHALL be regression-tested

Automated checks SHALL fail if bundled `ship-stage-watch` follow mode is given an events stream that includes `loop_run_superseded` and the watcher process is still alive after a short timeout. Those checks SHALL assert the process exited and that the identity-terminal material line was emitted. Those checks SHALL include a startup-race fixture that appends `loop_run_superseded` after the initial scan has reached EOF but before follow continues from that offset. Tests SHALL inject the events file and filter (or equivalent seam). Tests SHALL NOT start a live train, live messenger, or live ship.

#### Scenario: Regression fails on the v1.40.0 tail hang

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file contains or receives `loop_run_superseded`
- **AND** the watcher process is still alive after the test timeout
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when follow exits after superseded

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file contains or receives `loop_run_superseded`
- **AND** the watcher process exits after emitting the material line
- **THEN** the checks SHALL pass

#### Scenario: Regression fails when a terminal during scan-to-follow handoff is lost

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file receives `loop_run_superseded` after the initial scan has reached EOF but before follow continues from that scan offset
- **AND** the watcher process is still alive after the test timeout
- **THEN** the checks SHALL fail

#### Scenario: Regression passes when follow preserves a terminal appended at scan EOF

- **WHEN** the automated checks spawn bundled `ship-stage-watch` follow mode against a fixture events file
- **AND** that file receives `loop_run_superseded` after the initial scan has reached EOF but before follow continues from that scan offset
- **AND** the watcher process exits after emitting the material line
- **THEN** the checks SHALL pass

### Requirement: Host skill train notify SHALL use pipeline logs and the shared material filter

Host skill packaging for train orchestration SHALL prescribe a mandatory progress-notify step that parses `train_run_handoff` for `run_id` and the events path, follows `pipeline logs <train-run-id> --events --follow` piped through the shared material filter, and notifies via the host notify map on material train lines. When `train_loop_linked` publishes a loop run ID, the harness SHALL dual-follow that loop stream the same way §4b dual-follows a linked advance run, with the material filter on both streams. The guidance SHALL NOT teach `tail -F | grep` of unstructured train stdout as the primary notify path. Re-arm SHALL continue until train `run_complete`. This requirement SHALL NOT gate train mutations on notify delivery.

#### Scenario: Documented train follow uses logs plus material-filter

- **WHEN** an operator or agent reads host skill guidance for supervising `pipeline train`
- **THEN** the guidance SHALL name `pipeline logs <train-run-id> --events --follow` piped through `material-filter.mjs`
- **AND** SHALL NOT present `tail -F | grep` of train stdout as the primary path

#### Scenario: Linked loop run is dual-followed

- **WHEN** the train stream contains `train_loop_linked` with a real loop run id
- **THEN** host guidance SHALL apply the material filter to both the train stream and that loop stream
- **AND** SHALL NOT require dual raw unfiltered JSONL as the preferred path

#### Scenario: Re-arm until train run_complete

- **WHEN** a host follow/monitor is cancelled mid-train before `run_complete`
- **THEN** skill guidance SHALL instruct re-arming material follow until train `run_complete`
