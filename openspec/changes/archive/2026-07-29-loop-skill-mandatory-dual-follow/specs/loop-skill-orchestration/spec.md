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
4. When linkage publishes an active item’s advance `pipeline_run_id` and/or
   absolute advance `events` path (`loop_item_advance_linked` or equivalent),
   **SHALL** arm a follow on that advance event stream (dual-follow with the
   loop stream). Prefer `pipeline logs <advance-run-id> --events --follow` (or
   the host-packaged equivalent) when the advance run id is known; the absolute
   `events` path from the linkage record is an acceptable follow target. Before
   any such linkage is published, continue loop-only follow and do not require a
   non-existent advance-linkage field.
5. Stop following on a terminal loop outcome (including `loop_run_stopped`) or
   supervisor process exit; stop the previous item’s advance follow on terminal
   advance outcome when switching items.
6. Print a final summary (including `pipeline:loop --audit` or the documented
   summary surface).

#### Scenario: Ordered steps are present in host skill guidance

- **WHEN** an operator reads the loop orchestration section of `hosts/claude/SKILL.md`
  or `hosts/codex/SKILL.md`
- **THEN** the text SHALL list start/resume, handoff/`run_id`+events path, event
  follow, stop on terminal outcome or process exit, and summary/`--audit` as
  ordered steps
- **AND** the text SHALL require dual-follow of the linked advance event stream
  after advance linkage is published (not mark that step as merely optional)

#### Scenario: New drive obtains run_id before completion without early handoff

- **WHEN** a harness starts a new multi-item drive and no early handoff is present
- **THEN** the host skill guidance SHALL instruct non-blocking start plus race-safe
  state-home discovery of the run directory before supervisor exit
- **AND** SHALL NOT instruct relying solely on the terminal result JSON for
  mid-flight event following of that new drive

#### Scenario: Advance follow is not required before linkage exists

- **WHEN** no advance `run_id` or advance `events` path has been published for the
  active item
- **THEN** the harness SHALL still follow the loop event stream
- **AND** the docs SHALL NOT require a non-existent advance-linkage field

#### Scenario: Dual-follow is mandatory after advance linkage

- **WHEN** a loop event of kind `loop_item_advance_linked` (or equivalent start
  linkage) publishes `pipeline_run_id` and/or an absolute advance `events` path
  for the active item
- **THEN** host skill guidance SHALL instruct the harness to arm a follow on that
  advance event stream while continuing to follow the loop event stream
- **AND** SHALL NOT describe that advance follow as optional-only wording such as
  “optionally follow active item advance events”

---

## ADDED Requirements

### Requirement: Host skill guidance SHALL mandate dual-follow lifecycle after advance linkage

Host skill guidance for `pipeline:loop` drive and resume (Claude and Codex) SHALL
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

### Requirement: Dual-follow guidance SHALL list material advance event kinds for operator surface

Host skill guidance for mandatory dual-follow SHALL list material **advance**
event kinds that warrant harness notification or Push, in the same spirit as
single-issue advance orchestration. The must-surface set SHALL include at least
`stage_start`, `stage_complete`, `pr_created`, `review_verdict`, `gate_result`,
`blocker_set`, and `run_complete`. The guidance SHALL instruct suppressing pure
CI poll spam (including repeated `pre_merge.advancePolling`-style updates in the
same burst).

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

---

### Requirement: Docs SHALL state loop-only follow is insufficient for mid-item stage progress until dense loop progress ships

Host skill guidance SHALL document that following only the loop event stream
remains valid for schedule, hold, and terminal **loop** event kinds, but is
**insufficient alone** for mid-item stage progress (planning through pre-merge)
until the engine emits first-class stage progress on the loop stream (tracked as
#611, with pre-merge density as #682). The guidance SHALL cross-link those
issues (or successor identifiers). When #611 is implemented and the loop stream
carries first-class stage progress, this dual-follow mandate MAY be demoted to
optional or “recommended for full fidelity” in the same change that lands that
engine work, with host skill and living-spec updates together.

#### Scenario: Loop-only insufficiency is explicit

- **WHEN** an operator reads the dual-follow section of host skill guidance
- **THEN** the text SHALL state that loop-only follow does not provide mid-item
  stage progress until #611 (or documented successor) ships
- **AND** SHALL still allow loop-only attention for schedule/hold/terminal loop
  kinds

#### Scenario: Cross-links to parent progress work are present

- **WHEN** the dual-follow insufficiency or demotion note is present in host
  skill guidance
- **THEN** it SHALL name #611 and #682 (or documented successors) as the related
  engine progress-surface work

#### Scenario: Demotion is gated on engine progress density

- **WHEN** #611 has not yet made the loop stream sufficient for mid-item stage
  progress
- **THEN** host skill guidance SHALL keep dual-follow after linkage mandatory
- **AND** SHALL NOT demote dual-follow solely because an operator prefers quieter
  notifications

---

### Requirement: A drift-guard SHALL fail if post-linkage dual-follow regresses to optional-only wording

Automated tests covered by `npm run ci` SHALL fail if host skill guidance for
`pipeline:loop` drive/resume reintroduces optional-only advance follow as the
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
