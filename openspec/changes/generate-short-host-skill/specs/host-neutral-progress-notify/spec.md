## RENAMED Requirements

- FROM: ### Requirement: Host skill overlays SHALL document a host notify map for material progress
- TO: ### Requirement: Generated one-pagers SHALL render a compact host notify map for material progress
- FROM: ### Requirement: A shared material filter SHALL select skill-material events from events.jsonl
- TO: ### Requirement: A shared material filter SHALL select material progress events from events.jsonl
- FROM: ### Requirement: Skill §4 and §4b progress notify SHALL be host-parameterized
- TO: ### Requirement: Generated one-pager progress notify SHALL be manifest-parameterized
- FROM: ### Requirement: Grok-consumed packaging SHALL not teach Claude-only PushNotification as required
- TO: ### Requirement: Grok notify guidance SHALL come from its outer-host manifest
- FROM: ### Requirement: Progress notify SHALL re-arm until terminal and SHALL cross-link related issues
- TO: ### Requirement: Progress follow SHALL re-arm until terminal and durable docs SHALL cross-link related work
- FROM: ### Requirement: Material-progress notify mapping SHALL be declared on the outer-host manifest
- TO: ### Requirement: Outer-host manifests SHALL be the sole source of material-progress notify mappings
- FROM: ### Requirement: Host ship phrase SHALL exec the Pipeline ship CLI
- TO: ### Requirement: Outer-host ship entry points SHALL exec the Pipeline ship CLI
- FROM: ### Requirement: Host skill train notify SHALL use pipeline logs and the shared material filter
- TO: ### Requirement: Train progress guidance SHALL use pipeline logs and the shared material filter

## MODIFIED Requirements

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
