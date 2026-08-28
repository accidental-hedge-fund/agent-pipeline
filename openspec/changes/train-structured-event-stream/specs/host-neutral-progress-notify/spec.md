## ADDED Requirements

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

## MODIFIED Requirements

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
