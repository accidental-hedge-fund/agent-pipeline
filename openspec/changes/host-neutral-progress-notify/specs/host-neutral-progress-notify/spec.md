## ADDED Requirements

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
advance or loop `events.jsonl` lines and emits only skill-material progress
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

---

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

---

### Requirement: Drift-guards SHALL protect host notify maps and material kind alignment

Automated tests covered by `npm run ci` SHALL fail if:

1. The Grok-consumed skill path hard-requires Claude `PushNotification` without
   a Grok host-map substitute (`monitor` or documented equivalent).
2. Host skill material kind lists used for notify drift from the shared material
   filter's kind set (or shared single-source constant) for the required advance
   and loop kinds.
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

#### Scenario: Claude map regression fails the guard

- **WHEN** `hosts/claude/SKILL.md` no longer documents a material progress notify
  surface for advance orchestration
- **THEN** the drift-guard test or check SHALL fail under `npm run ci`
