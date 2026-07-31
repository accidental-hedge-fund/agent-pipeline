## MODIFIED Requirements

### Requirement: Material loop event kinds SHALL be listed for harness notifications

Loop orchestration guidance SHALL list material loop event kinds that warrant a
harness notification via the **host notify map** (Claude `PushNotification`,
Grok host `monitor` material lines, Codex chat/status — not a single universal
Claude-only tool). The must-notify set SHALL include at least
`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`,
`loop_item_advance_linked` (or equivalent linkage kind), material
`loop_item_stage_progress` when present, material `loop_item_progress`, and
`loop_run_stopped`. The guidance SHALL also name schedule and reconcile event
kinds that are appropriate to surface without requiring a notification on every
identical repeated evaluation in a polling burst. Host skill text SHALL apply
the shared material filter (or equivalent material-only rules) so dual raw
unfiltered JSONL notify is not the preferred path.

#### Scenario: Must-notify kinds are named

- **WHEN** an operator reads the material-events list in host skill guidance
- **THEN** the list SHALL include `loop_item_started`, `loop_item_transitioned`,
  `loop_item_blocked`, and `loop_run_stopped`

#### Scenario: Burst suppression is documented

- **WHEN** the guidance describes schedule or reconcile notifications
- **THEN** it SHALL instruct harnesses to suppress repeated identical evaluations
  in the same burst rather than notify on every identical line

#### Scenario: Notify is host-map based not Claude-only

- **WHEN** an operator reads the loop material-notify step in Claude, Codex, or
  Grok-consumed skill packaging
- **THEN** the mandatory step SHALL refer to the host notify map (or host-local
  equivalent)
- **AND** non-Claude hosts SHALL NOT be required to call `PushNotification`

---

### Requirement: Loop orchestration docs SHALL treat pre-merge gate progress as material loop events

Host skill guidance for `pipeline:loop` drive and resume SHALL list the shared
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

### Requirement: Dual-follow guidance SHALL list material advance event kinds for operator surface

Host skill guidance for mandatory dual-follow SHALL list material **advance**
event kinds that warrant harness notification via the host notify map, in the
same spirit as single-issue advance orchestration and aligned with the shared
material filter. The must-surface set SHALL include at least `stage_start`,
`stage_complete`, `pr_created`, `review_verdict`, `gate_result`, `blocker_set`,
and `run_complete` (and SHOULD include `run_start`, `pr_updated`, and
`blocker_cleared` when present on the advance stream). The guidance SHALL
instruct suppressing pure CI poll spam (including repeated
`pre_merge.advancePolling`-style updates and repeated CI `partial` / OpenSpec
`skipped` spam in the same burst). Dual-follow SHALL apply material-only notify
rules to **both** the loop stream and the linked advance stream.

#### Scenario: Material advance kinds are named

- **WHEN** an operator reads the dual-follow / advance material-events guidance
  in host skill text
- **THEN** the list SHALL include `stage_start`, `stage_complete`, `pr_created`,
  `review_verdict`, `gate_result`, `blocker_set`, and `run_complete`

#### Scenario: CI poll spam is suppressed

- **WHEN** the advance stream emits repeated identical polling-loop sub-events
  during pre-merge CI wait
- **THEN** the guidance SHALL instruct the harness to suppress subsequent
  identical polling updates in the same burst rather than notify on every line

#### Scenario: Both dual-follow streams are material-filtered

- **WHEN** dual-follow is active for a linked advance run
- **THEN** host guidance SHALL prefer material-filtered notify on loop and
  advance streams over dual raw unfiltered JSONL as the primary notify path

## ADDED Requirements

### Requirement: Loop skill packaging SHALL include Grok in host-notify and dual-follow guidance surfaces

Host skill guidance for `pipeline:loop` drive and resume SHALL cover every
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
