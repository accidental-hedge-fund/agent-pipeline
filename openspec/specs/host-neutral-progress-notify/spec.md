# host-neutral-progress-notify Specification

## Purpose
TBD - created by archiving change host-neutral-progress-notify. Update Purpose after archive.
## Requirements
### Requirement: Progress notify SHALL NOT gate stages or introduce a push microservice

Material progress notify SHALL remain an observation concern driven by structured
`events.jsonl` and the active outer-host manifest mapping. Pipeline SHALL NOT gate
stage transitions, review, or deploy-ready on delivery of a human notification.
The default path SHALL use the manifest-declared host-local surface or portable
fallback, not a Pipeline-owned push, Slack, or Discord microservice.

#### Scenario: No delivery-gated stages

- **WHEN** a material event is written to `events.jsonl`
- **THEN** stage advancement and gates SHALL proceed without requiring proof that
  a host notification was delivered

#### Scenario: No default push microservice

- **WHEN** generated or durable guidance describes progress notify
- **THEN** it SHALL use the active manifest mapping fed by `events.jsonl`
- **AND** it SHALL NOT require a Pipeline-owned external push service for default
  operation

---

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

Automated tests covered by `npm run ci` SHALL fail when a generated notify row
differs from its outer-host manifest's `material_progress_notify.mapping`, when
renderer code introduces an independent notify-value map or host-name behavior
dispatch, when build-target
membership and manifest-row projection use different lists, when durable
material-kind documentation drifts from the shared filter, or when a manifest
loses its declared notify surface without an intentional fallback. The one
authoritative `SKILL_HOST_IDS` membership list SHALL be permitted. Generated
one-pagers SHALL NOT be required to duplicate the full material-kind lists for
this guard.

#### Scenario: Manifest-to-render drift fails

- **WHEN** a generated compact row does not match the corresponding
  `material_progress_notify.mapping` fields
- **THEN** the generation or freshness test SHALL fail under `npm run ci`

#### Scenario: Second map or host dispatch fails

- **WHEN** shared rendering code defines notify values in a second map keyed by
  known host ids or branches on a host id to choose a tool
- **THEN** the source-of-truth guard SHALL fail
- **AND** the guard SHALL NOT fail solely because the shared
  `SKILL_HOST_IDS` membership list selects build targets and manifest rows

#### Scenario: Material kind list drift fails the guard

- **WHEN** the shared filter drops a required advance, loop, or train kind, or
  durable docs claim a kind the filter no longer treats as material
- **THEN** the drift-guard or unit test SHALL fail under `npm run ci`

#### Scenario: Train material kind list drift fails the guard

- **WHEN** the shared filter drops a required train material kind or durable
  train docs claim a divergent train material kind
- **THEN** the drift-guard or unit test SHALL fail under `npm run ci`

#### Scenario: Claude-only tool on Grok path fails the guard

- **WHEN** a generated Grok map row requires Claude `PushNotification` contrary
  to the Grok manifest
- **THEN** the manifest/render parity guard SHALL fail under `npm run ci`

#### Scenario: Claude map regression fails the guard

- **WHEN** the Claude manifest declares a material notify surface but the
  generated compact map drops that row or changes its values
- **THEN** the manifest/render parity guard SHALL fail under `npm run ci`

#### Scenario: Portable fallback remains available

- **WHEN** a host declares limited or unsupported rich notification
- **THEN** its manifest SHALL declare a portable stdout/material-events fallback
- **AND** the conformance guard SHALL fail if neither a surface nor fallback is
  available

---

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

### Requirement: Generated one-pagers SHALL render a compact host notify map for material progress

Generated host one-pagers SHALL contain one byte-identical compact notify map
rendered from the `material_progress_notify` declarations in the outer-host
manifest registry. One authoritative `SKILL_HOST_IDS` membership list SHALL name
Claude, Codex, Grok, and OpenCode and exclude OMP; `scripts/build.mjs` SHALL use
that same list for generated SKILL targets, and `core/scripts/host-skill.ts`
SHALL use it for manifest-row projection. The list defines membership only.
Manifest declarations SHALL remain the only source of each row's mapping
fields: `surface`, `tools`, and `filter`. Per-host fallback declarations SHALL
remain manifest-owned and MAY be explained in durable operator documentation;
the compact rendered row SHALL NOT duplicate fallback prose. The renderer SHALL
accept an injectable manifest collection for fixture coverage, defaulting to
the repository/builtin outer-host registry in production. It SHALL NOT hardcode
a second notify-value map or dispatch notification behavior on host names. An
active host in `SKILL_HOST_IDS` selects its compact row at runtime; a supported
non-selected host uses its manifest mapping or fallback outside the generated
four-row table. The shared contract SHALL require notifying through that
selected declaration on material events, and the follower SHALL NOT invoke a
merge-capable command as a notify side effect.

#### Scenario: Manifest declarations render the compact map

- **WHEN** the generator supplies the outer-host manifest registry and shared
  `SKILL_HOST_IDS` membership to `renderHostSkill`
- **THEN** every generated one-pager SHALL contain the same compact rows derived
  from the selected manifests' `material_progress_notify.mapping` fields
- **AND** changing a mapping field in a manifest fixture SHALL change the
  rendered row through the injectable manifest seam without editing
  `host-skill.ts`

#### Scenario: Claude map names PushNotification for that host only

- **WHEN** the Claude manifest row is rendered in a generated one-pager
- **THEN** it SHALL name Monitor plus `PushNotification` (or its declared
  successor) when those are the manifest values
- **AND** Claude-only tools SHALL appear only in the Claude row

#### Scenario: Grok map never requires PushNotification

- **WHEN** the Grok manifest row is rendered in a generated one-pager
- **THEN** its `surface`, `tools`, and `filter` cells SHALL match the Grok
  manifest mapping
- **AND** any portable fallback detail SHALL remain in the manifest and durable
  operator documentation rather than a per-row fallback essay
- **AND** it SHALL NOT require Claude `PushNotification`

#### Scenario: Codex map uses chat/status without Claude tool names

- **WHEN** the Codex manifest row is rendered in a generated one-pager
- **THEN** it SHALL use the chat/status surface declared by that manifest
- **AND** it SHALL NOT list `PushNotification` as a required Codex tool

#### Scenario: Renderer contains no second host map

- **WHEN** the renderer and its tests are inspected
- **THEN** no independent map keyed by known host names SHALL define notify
  values; the sole `SKILL_HOST_IDS` membership list is permitted
- **AND** adding a manifest-backed SKILL host SHALL require at most one membership
  update and its manifest declaration, not a notify-value copy or host-name
  dispatch branch in shared orchestration or rendering code

---

### Requirement: A shared material filter SHALL select material progress events from events.jsonl

The repository SHALL provide one shared material filter consumed by event-follow
paths and referenced by durable operator documentation. Outer-host manifest
notify mappings SHALL point at that filter or a contract-equivalent CLI mode.
The generated one-pager MAY name the filter and link to the durable event
reference; it SHALL NOT duplicate the complete event-kind inventory or
spam-suppression essay.

For advance streams, the material set SHALL include at least `run_start`,
`stage_start`, `stage_complete`, `pr_created`, `pr_updated`,
`review_verdict`, `gate_result`, `blocker_set`, `blocker_cleared`, and
`run_complete`.

For loop streams, the material set SHALL include at least
`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
`loop_item_advance_linked`, the terminal item-advance linkage kinds,
`loop_item_stage_progress`, material `loop_item_progress`, and
`loop_run_stopped`.

For train streams, the material set SHALL include at least `run_start`,
`train_work_list_resolved`, `train_wave_started`, `train_loop_linked`,
`train_item_started`, `train_item_completed`, `train_pr_created`,
`train_merge_attempted`, `train_merge_proven`, `train_merge_integrated`,
`train_sibling_halted`, `train_wave_ended`, and `run_complete`.

The filter SHALL suppress repeated identical CI polling bursts after the first
material gate event, repeated CI `partial` and OpenSpec `skipped` outcomes,
non-first CI `waiting` polls in a `loop_item_progress` stretch, and non-listed
heartbeat or accounting kinds. Unfiltered `events.jsonl` SHALL remain unchanged
as the complete evidence stream.

#### Scenario: Advance material kinds pass the filter

- **WHEN** an advance fixture contains the required advance kinds among
  heartbeat, accounting, and polling noise
- **THEN** every required advance kind SHALL appear in filter output
- **AND** non-listed noise SHALL NOT appear

#### Scenario: Loop material kinds pass the filter

- **WHEN** a loop fixture contains the required loop kinds among non-material
  events
- **THEN** every required loop kind SHALL appear in filter output

#### Scenario: Train material kinds pass the filter

- **WHEN** a train fixture contains the required train kinds among heartbeat,
  accounting, and child-engine noise
- **THEN** every required train kind SHALL appear in filter output
- **AND** non-listed noise SHALL NOT appear

#### Scenario: CI partial and repeated waiting are suppressed

- **WHEN** the filter sees repeated identical CI `partial`, OpenSpec `skipped`,
  or CI `waiting` lines in one stretch
- **THEN** it SHALL suppress repeated spam
- **AND** it SHALL still emit the first material wait when applicable and every
  definitive outcome

#### Scenario: Raw events.jsonl remains complete

- **WHEN** a run appends events to `events.jsonl`
- **THEN** the filter SHALL NOT remove or rewrite lines in the run-store file
- **AND** unfiltered `pipeline logs … --events` SHALL still expose the complete
  stream

#### Scenario: One-pager points instead of copying the inventory

- **WHEN** a generated host one-pager is inspected
- **THEN** it SHALL name the shared material observation path or link to its
  durable reference
- **AND** it SHALL NOT be required to list every advance, loop, and train kind

---

### Requirement: Generated one-pager progress notify SHALL be manifest-parameterized

The generated one-pager SHALL prescribe a compact progress protocol that follows
the structured event stream, applies the shared material filter when notifying,
and selects the notification surface from the active outer-host manifest row.
It SHALL NOT recreate §4, §4b, or §4c host-specific prose, and shared code SHALL
NOT branch on host names to select notify tools. Durable operator documentation
MAY retain the detailed dual-follow and diagnostic procedures.

#### Scenario: Shared notify step is host-map based

- **WHEN** the generated one-pager describes material progress notification
- **THEN** it SHALL direct the follower to use the active manifest-derived row
- **AND** it SHALL NOT unconditionally require Claude `PushNotification`

#### Scenario: Dual-follow uses material filter on both streams

- **WHEN** an operator needs linked loop/advance diagnostic fidelity
- **THEN** durable orchestration documentation SHALL describe the applicable
  material-filtered streams
- **AND** the generated one-pager SHALL NOT be required to contain FIFO or
  state-home discovery scripts

#### Scenario: Claude host retains PushNotification as its map entry

- **WHEN** the Claude outer-host manifest declares `PushNotification` in its
  material-progress mapping
- **THEN** the generated compact table SHALL retain that value in the Claude row
- **AND** other host rows SHALL remain governed by their own manifest values

---

### Requirement: Grok notify guidance SHALL come from its outer-host manifest

Grok's compact progress row SHALL be rendered from the
`material_progress_notify.mapping` in
`hosts/grok/outer-host.manifest.json` and SHALL use that mapping's `monitor` (or
successor) surface, tools, and material filter. The manifest-owned portable
fallback SHALL remain available through durable operator documentation without
being duplicated as per-row fallback prose. The byte-identical generated
one-pager SHALL include that row without becoming a distinct Grok install
overlay. Shared rendering and orchestration SHALL NOT hard-require Claude
`PushNotification` for Grok and SHALL NOT special-case the `grok` host id.

#### Scenario: Grok path documents monitor + material filter

- **WHEN** the Grok manifest declares its material-progress mapping
- **THEN** the generated compact map SHALL render its monitor surface
- **AND** the renderer SHALL NOT contain a Grok-specific conditional

#### Scenario: Symlink or Claude overlay consumers get an explicit Grok substitute when no hosts/grok exists

- **WHEN** Grok consumes the Claude-managed byte-identical one-pager through the
  existing symlink lifecycle
- **THEN** the shared map SHALL still contain the Grok manifest row
- **AND** no separate Grok overlay or Claude-only notify requirement SHALL be
  introduced

---

### Requirement: Progress follow SHALL re-arm until terminal and durable docs SHALL cross-link related work

The shared compact follow contract SHALL require reattaching after a cancelled or
interrupted follow and continuing until `run_complete`, `loop_run_complete`, or
`loop_run_stopped` as applicable. Durable orchestration documentation, rather
than each generated one-pager, SHALL carry cross-links to wait-cancel reattach
work (#725 or successor) and denser loop progress work (#611 or successor).

#### Scenario: Re-arm until terminal is documented

- **WHEN** an event follow is interrupted before a terminal event
- **THEN** the generated one-pager SHALL require reattachment
- **AND** it SHALL not classify the interrupted wait as terminal

#### Scenario: Dual-follow density points to #611

- **WHEN** an operator reads the detailed progress-follow documentation
- **THEN** it SHALL cross-link #725 and #611 (or documented successors) where
  reattach and dual-follow density are discussed
- **AND** generated one-pagers SHALL NOT be required to repeat those issue-history
  notes

---

### Requirement: Outer-host manifests SHALL be the sole source of material-progress notify mappings

Each supported outer-host manifest SHALL declare its material-progress notify
capability, surface, filter, and fallback. The outer-host registry SHALL expose
those declarations to shared orchestration and one-pager rendering. Consumers
SHALL select the active row from registry data. The sole `SKILL_HOST_IDS` list
MAY select which manifest-backed hosts receive generated SKILL targets and
rendered rows, but SHALL contain no notify values. No shared module SHALL
maintain a second notify-value map, infer notify behavior from a host name, or
require edits to a host-name behavior switch when a manifest-backed SKILL host
is added.

#### Scenario: Shared orchestration reads notify capability from the manifest

- **WHEN** shared advance, loop, or train observation requires material progress
  notification
- **THEN** it SHALL use the active outer host's declared mapping or fallback
- **AND** it SHALL NOT require a shared host-name switch

#### Scenario: Renderer reads the same declarations

- **WHEN** the generated one-pager renders its compact map
- **THEN** it SHALL consume the same injectable registry declarations used by
  orchestration, projected through the shared `SKILL_HOST_IDS` membership
- **AND** it SHALL NOT copy their values into a renderer-owned constant

#### Scenario: Host without rich notify uses portable fallback

- **WHEN** an outer host declares rich notification unsupported or limited
- **THEN** its fallback SHALL use stdout and/or filtered `events.jsonl` material
  lines
- **AND** shared orchestration SHALL NOT hard-require Claude tools for that host

---

### Requirement: Outer-host ship entry points SHALL exec the Pipeline ship CLI

Every configured outer-host entry point SHALL map the operator phrase
`Ship milestone vX.Y.Z` to `pipeline ship --milestone vX.Y.Z`. Status and stop
SHALL read the Pipeline ship ledger, and notify SHALL follow exact child-run
identities through the shared material filter. The four generated short
one-pagers MAY expose `ship` as a compact explicit-authority verb. They SHALL
NOT be required to carry a host-by-host ship tutorial. OMP/Tugboat SHALL require
no SKILL, and this change SHALL NOT materialize Hermes or OpenClaw install
packs; later consumers MAY reuse the exported one-pager source.

#### Scenario: Phrase becomes the milestone CLI

- **WHEN** an outer-host integration exposes `Ship milestone v1.39.3`
- **THEN** it SHALL exec `pipeline ship --milestone v1.39.3`
- **AND** it SHALL NOT start a host-owned ship state machine

#### Scenario: Notify follows the ship ledger

- **WHEN** the ship ledger advances phase, an item merges, or the ship fails
- **THEN** the notify path SHALL emit the material transition with exact child-run
  identity
- **AND** it SHALL NOT infer the ship from a host-global latest-run directory

#### Scenario: This change does not materialize excluded host SKILLs

- **WHEN** the short-SKILL generator runs for issue #1049
- **THEN** it SHALL NOT generate OMP, Tugboat, Hermes, or OpenClaw SKILL files
- **AND** their wrapper or later packaging contracts SHALL remain independent of
  this generator's four committed targets

---

### Requirement: Train progress guidance SHALL use pipeline logs and the shared material filter

Durable train orchestration documentation SHALL parse `train_run_handoff` for
`run_id` and the events path, follow
`pipeline logs <train-run-id> --events --follow` through the shared material
filter, use the active manifest-derived notify row, and continue until train
`run_complete`. The docs SHALL describe linked loop observation when full
diagnostic fidelity is required. The generated one-pager SHALL expose only the
compact shared follow contract and `train` verb; it SHALL NOT carry the retired
train dual-follow shell essay. Notification delivery SHALL NOT gate train
mutations.

#### Scenario: Documented train follow uses logs plus material-filter

- **WHEN** an operator reads the detailed train supervision documentation
- **THEN** it SHALL name
  `pipeline logs <train-run-id> --events --follow` through the shared material
  filter
- **AND** it SHALL use the active outer-host manifest notify row

#### Scenario: Linked loop run is dual-followed

- **WHEN** `train_loop_linked` publishes a loop run id and full diagnostic
  fidelity is needed
- **THEN** durable docs SHALL describe material-filtered observation of both
  exact streams
- **AND** generated one-pagers SHALL NOT be required to embed the dual-follow
  implementation

#### Scenario: Re-arm until train run_complete

- **WHEN** a train event follow is interrupted before `run_complete`
- **THEN** the shared follow contract SHALL require reattachment
- **AND** notification delivery failure SHALL NOT stop or advance the train

