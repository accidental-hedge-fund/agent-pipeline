## RENAMED Requirements

- FROM: ### Requirement: Material loop event kinds SHALL be listed for harness notifications
- TO: ### Requirement: Shared material-event filtering and durable docs SHALL define loop notifications
- FROM: ### Requirement: Docs SHALL provide an interim loop events follow path without forbidding monitoring
- TO: ### Requirement: Loop orchestration SHALL prefer the dedicated logs follow without forbidding monitoring
- FROM: ### Requirement: Loop orchestration docs SHALL treat pre-merge gate progress as material loop events
- TO: ### Requirement: Shared material-event filtering SHALL treat pre-merge gate progress as material loop events
- FROM: ### Requirement: Loop orchestration docs SHALL keep optional advance follow for full fidelity
- TO: ### Requirement: Durable loop docs SHALL preserve linked-advance full-fidelity guidance
- FROM: ### Requirement: Host skill guidance SHALL mandate dual-follow lifecycle after advance linkage
- TO: ### Requirement: Shared loop contract SHALL mandate linked-advance follow lifecycle after linkage
- FROM: ### Requirement: Dual-follow guidance SHALL list material advance event kinds for operator surface
- TO: ### Requirement: Shared material-event filtering SHALL define linked-advance notifications
- FROM: ### Requirement: Docs SHALL state loop-only follow is insufficient for mid-item stage progress until dense loop progress ships
- TO: ### Requirement: Durable loop docs SHALL explain linked-advance fidelity until dense loop progress ships
- FROM: ### Requirement: A drift-guard SHALL fail if post-linkage dual-follow regresses to optional-only wording
- TO: ### Requirement: A drift-guard SHALL fail if post-linkage advance follow regresses to optional-only wording
- FROM: ### Requirement: Loop skill packaging SHALL include Grok in host-notify and dual-follow guidance surfaces
- TO: ### Requirement: Generated loop skill packaging SHALL share host-neutral notify and linked-follow guidance

## MODIFIED Requirements

### Requirement: `pipeline loop` packaging SHALL NOT claim seconds-only runs or forbid Monitor

The shared one-pager renderer and durable operator docs SHALL classify `pipeline loop` drive and resume as long-running and SHALL direct the observer to retain the handoff `loop_run_id` and use `pipeline loop logs <loop-run-id> --events --follow`. No generated host SKILL or durable loop guide SHALL claim that drive or resume completes in seconds or that no background follow or host-equivalent Monitor is needed. Read-only `pipeline loop --audit` MAY remain documented as a short synchronous mode. This requirement SHALL NOT depend on a generated per-verb command file.

#### Scenario: Host loop guidance omits the fast-path falsehood

- **WHEN** any generated host SKILL describes loop drive or resume
- **THEN** it SHALL name `pipeline loop logs <loop-run-id> --events --follow`
- **AND** it SHALL NOT contain the fast-path claims “completes in seconds” or “No background process or Monitor needed”

#### Scenario: Plugin command mirror matches the long-running classification

- **WHEN** packaging is generated
- **THEN** it SHALL NOT write `plugin/pipeline/commands/pipeline:loop.md` or an equivalent per-verb agent file
- **AND** loop follow guidance SHALL come from the shared one-pager and durable docs

#### Scenario: Audit mode stays synchronous

- **WHEN** durable docs describe `pipeline loop --audit`
- **THEN** they MAY call that read-only operation short and synchronous
- **AND** they SHALL NOT apply that classification to drive or resume

---

### Requirement: Loop orchestration docs SHALL specify handoff, follow, notify, stop, and summarize

`core/scripts/host-skill.ts` and every generated host SKILL SHALL carry the same compact, ordered loop protocol: retain `loop_run_id` from the durable handoff; follow `pipeline loop logs <loop-run-id> --events --follow`; notify material events through the active host-notify row; after `loop_item_advance_linked` publishes `pipeline_run_id`, retain that value as the linked `advance_run_id` and also follow that item with `pipeline logs <advance-run-id> --events --follow`; re-attach any interrupted live follow with the retained id; and on `loop_run_complete`, `loop_run_stopped`, or any supervisor exit stop all follows scoped to that loop in the same turn. A confirmed terminal loop event SHALL lead to a final summary containing the terminal reason and confirmation that follows stopped. A supervisor exit before terminal SHALL instead be reported as a non-terminal failure/recovery condition and SHALL NOT be called completion. The follower SHALL NOT invoke a merge-capable command. Detailed state-home discovery, event inventories, and dual-follow scripts SHALL live in durable docs or the shared material filter rather than in a generated SKILL.

#### Scenario: Ordered steps are present in host skill guidance

- **WHEN** an operator reads any generated host SKILL
- **THEN** it SHALL list retained `loop_run_id`, `pipeline loop logs <loop-run-id> --events --follow`, material notify, retained linked `advance_run_id`, linked advance follow, retained-id re-attach, terminal-or-exit teardown, and confirmed-terminal final summary as compact ordered obligations
- **AND** it SHALL distinguish the loop command from `pipeline logs <advance-run-id> --events --follow`
- **AND** it SHALL report premature supervisor exit as non-terminal failure/recovery rather than completion

#### Scenario: New drive obtains run_id before completion without early handoff

- **WHEN** a harness starts a new drive
- **THEN** the compact contract SHALL require retaining `loop_run_id` from the durable handoff before following
- **AND** durable docs SHALL describe race-safe state-home discovery when an early handoff is unavailable

#### Scenario: Optional item-advance follow is not required before linkage exists

- **WHEN** the active item has not published a `loop_item_advance_linked` event
  carrying `pipeline_run_id`
- **THEN** the harness SHALL continue the loop logs follow
- **AND** it SHALL NOT guess a linked advance id

#### Scenario: Stop step requires same-turn teardown

- **WHEN** the loop becomes terminal or its supervisor exits
- **THEN** the compact contract SHALL require same-turn teardown of the loop follow and any linked advance follow
- **AND** a confirmed terminal event SHALL produce the terminal reason and follows-stopped summary
- **AND** an exit without confirmed terminal SHALL produce a non-terminal failure/recovery report and SHALL NOT claim completion

#### Scenario: The follower does not merge

- **WHEN** the loop follower reports progress or terminal state
- **THEN** it SHALL NOT invoke `merge`, `merge-queue --apply`, `train --merge`, or `ship`

---

### Requirement: Shared material-event filtering and durable docs SHALL define loop notifications

The shared material-event filter and durable operator docs SHALL define which loop events warrant notification through the compact host-notify map. The material set SHALL include `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, `loop_item_advance_linked` (or its successor), material `loop_item_stage_progress`, material `loop_item_progress`, and `loop_run_stopped`, plus useful schedule and reconcile outcomes. Repeated identical evaluations in one polling burst SHALL be suppressed. Every generated SKILL SHALL state only the compact rule to notify material events through the active host row; it SHALL NOT be required to reproduce the event inventory.

#### Scenario: Must-notify kinds are named

- **WHEN** the material loop event set is inspected
- **THEN** it SHALL include item start, transition, blocker, advance linkage, material progress, and terminal stop events

#### Scenario: Burst suppression is documented

- **WHEN** schedule, reconcile, or waiting events repeat identically in one polling burst
- **THEN** the shared filter SHALL surface the first material occurrence and suppress the repeated noise

#### Scenario: Notify is host-map based not Claude-only

- **WHEN** any generated host SKILL is read
- **THEN** it SHALL require material notification through the selected host-notify row
- **AND** it SHALL point to durable docs rather than list every event kind or hard-require Claude `PushNotification`

---

### Requirement: Loop orchestration SHALL prefer the dedicated logs follow without forbidding monitoring

The shared one-pager renderer SHALL use `pipeline loop logs <loop-run-id> --events --follow` with the retained handoff `loop_run_id` as the primary loop follow path. Durable operator docs SHALL retain `<state-home>/runs/<loop_run_id>/events.jsonl` and the state-home resolution order as a diagnostic fallback, but the generated SKILL SHALL NOT carry the fallback discovery essay or claim that `pipeline status` discovers the id. Neither shared nor durable guidance SHALL forbid a persistent host-equivalent Monitor or background follow for loop drive and resume.

#### Scenario: Interim path is concrete

- **WHEN** durable docs describe the raw loop-event diagnostic fallback
- **THEN** they SHALL name `<state-home>/runs/<loop_run_id>/events.jsonl`
- **AND** they SHALL describe the state-home resolution order while the generated one-pager uses `pipeline loop logs <loop-run-id> --events --follow` as primary

#### Scenario: Monitoring is never forbidden for drive/resume

- **WHEN** drive or resume guidance is read
- **THEN** it SHALL use the dedicated logs follow or document the raw event path as a fallback
- **AND** it SHALL NOT forbid a persistent Monitor, background process, or event follow

---

### Requirement: A drift-guard SHALL fail if the seconds-only / no-Monitor loop guidance returns

Automated checks covered by `npm run ci` SHALL fail if `renderHostSkill()`, any generated host SKILL, or the durable loop docs classify loop drive/resume as seconds-only, forbid follow/Monitor, or omit the retained-id primary `pipeline loop logs <loop-run-id> --events --follow` contract. The guard SHALL inspect shared rendered output and durable docs and SHALL NOT depend on `renderClaudeCommand` or a generated per-verb command file.

#### Scenario: Forbidden phrase fails the guard

- **WHEN** the shared renderer or any generated host SKILL says loop drive/resume completes in seconds or needs no background follow
- **THEN** the drift guard SHALL fail

#### Scenario: True-fast commands remain allowed to use the fast template

- **WHEN** docs classify `status`, `doctor`, or read-only loop audit as synchronous
- **THEN** the loop drift guard SHALL NOT fail solely for that classification

---

### Requirement: Shared material-event filtering SHALL treat pre-merge gate progress as material loop events

The shared material-event filter and durable loop docs SHALL treat the shared loop progress kind (`loop_item_progress` or its successor) as material when `domain` is `pre_merge` and `status` is a definitive outcome (`pass`, `fail`, `approve`, `needs_attention`, `attempted`, `success`, `exhausted`, `blocked`, `advanced`, or `started`) or the first `waiting` event in a CI stretch. Durable docs SHALL explain that these outcomes are mirrored on the loop stream while advance linkage is active. The generated one-pager SHALL retain only the compact material-notify obligation.

#### Scenario: Material list includes progress kind

- **WHEN** a linked item emits a definitive pre-merge progress result
- **THEN** the shared material filter SHALL surface it from the loop event stream

#### Scenario: First waiting only per CI stretch

- **WHEN** identical CI `waiting` progress repeats in a polling stretch
- **THEN** the shared filter SHALL surface the first event and suppress subsequent identical waits until a definitive outcome

#### Scenario: Docs state loop stream carries pre-merge gate outcomes

- **WHEN** durable docs describe mid-item progress while advance linkage is active
- **THEN** they SHALL state that material pre-merge gate outcomes are mirrored on the loop stream
- **AND** generated host SKILLs SHALL retain the compact material-notify rule without enumerating every status

---

### Requirement: Durable loop docs SHALL preserve linked-advance full-fidelity guidance

Durable operator docs SHALL explain that `pipeline logs <advance-run-id> --events --follow`, using the advance id published by loop linkage, provides full-fidelity stage and harness detail. They MAY describe linked advance follow as unnecessary solely for gate outcomes already mirrored onto the loop stream, while the compact shared loop contract continues to require the linked follow for the complete mid-item lifecycle until the dense loop-progress requirement permits demotion. Generated SKILLs SHALL NOT embed raw events-path or FIFO examples.

#### Scenario: Optional advance follow remains documented

- **WHEN** an operator needs full-fidelity detail for a linked item
- **THEN** durable docs SHALL name `pipeline logs <advance-run-id> --events --follow`
- **AND** they SHALL distinguish it from the primary loop logs command

#### Scenario: Mirrored gate outcomes do not require advance-only parsing

- **WHEN** a pre-merge gate outcome is already present on the loop stream
- **THEN** durable docs SHALL NOT claim that the linked advance stream is the only way to observe that gate outcome

---

### Requirement: Shared loop contract SHALL mandate linked-advance follow lifecycle after linkage

The compact shared loop contract and every generated host SKILL SHALL require that, after `loop_item_advance_linked` publishes `pipeline_run_id`, the observer retains that value as the linked `advance_run_id`, keeps `pipeline loop logs <loop-run-id> --events --follow` active with the handoff `loop_run_id`, and adds `pipeline logs <advance-run-id> --events --follow`. When a later item publishes a new linkage value or the prior advance becomes terminal, the observer SHALL stop or replace the prior advance follow rather than accumulating stale follows. The loop follow SHALL continue until the loop becomes terminal or its supervisor exits. A premature supervisor exit SHALL stop all run-scoped follows and yield non-terminal failure/recovery, not completion. Detailed dual-follow implementations SHALL live in durable docs, not in generated SKILL bash.

#### Scenario: Skill names preferred advance follow command

- **WHEN** a loop item publishes `pipeline_run_id` in
  `loop_item_advance_linked`
- **THEN** the compact contract SHALL retain that value as `<advance-run-id>` and
  require `pipeline logs <advance-run-id> --events --follow` while retaining
  `pipeline loop logs <loop-run-id> --events --follow`

#### Scenario: Item switch stops prior advance follow

- **WHEN** a later item publishes a new advance id or the prior advance reaches terminal
- **THEN** the observer SHALL stop or replace the prior advance follow
- **AND** it SHALL NOT leave an unbounded set of stale advance follows

#### Scenario: Loop follow continues across item boundaries

- **WHEN** a linked advance follow ends while the loop remains live
- **THEN** the observer SHALL keep the loop logs follow active

---

### Requirement: Shared material-event filtering SHALL define linked-advance notifications

The shared material-event filter and durable operator docs SHALL define the material linked-advance kinds, including `stage_start`, `stage_complete`, `pr_created`, `review_verdict`, `gate_result`, `blocker_set`, and `run_complete`, with `run_start`, `pr_updated`, and `blocker_cleared` when present. Repeated CI polling, repeated `partial` results, and repeated OpenSpec `skipped` noise in the same burst SHALL be suppressed. The generated one-pager SHALL apply the shared material-only rule to loop and linked-advance streams without reproducing the event inventory.

#### Scenario: Material advance kinds are named

- **WHEN** linked advance events pass through the shared material filter
- **THEN** stage, PR, review, gate, blocker, and terminal events SHALL be eligible for notification

#### Scenario: CI poll spam is suppressed

- **WHEN** an advance emits repeated identical CI polling or skipped updates in one burst
- **THEN** the shared filter SHALL suppress repeated noise after the first material line

#### Scenario: Both dual-follow streams are material-filtered

- **WHEN** linked-advance follow is active
- **THEN** the observer SHALL notify material events from both streams through the active host row
- **AND** raw unfiltered dual JSONL SHALL NOT be the preferred notification path

---

### Requirement: Durable loop docs SHALL explain linked-advance fidelity until dense loop progress ships

Durable operator docs SHALL explain that the loop stream covers schedule, hold, mirrored gate progress, and terminal loop events, while linked advance follow remains required for complete mid-item stage progress until the loop stream provides the dense first-class progress tracked by #611 and #682 (or documented successors). Those historical and diagnostic details SHALL NOT be required in each generated SKILL. The compact shared contract SHALL retain linked-advance follow until the engine change and living spec deliberately demote it together.

#### Scenario: Loop-only insufficiency is explicit

- **WHEN** an operator reads the linked-follow documentation
- **THEN** it SHALL explain what the loop stream covers and what detail still requires linked advance follow
- **AND** it SHALL name #611 and #682 or their documented successors

#### Scenario: Cross-links to parent progress work are present

- **WHEN** durable docs explain the current linked-advance fidelity boundary
- **THEN** they SHALL cross-link #611 and #682 or documented successor work
- **AND** the generated one-pager SHALL NOT be required to carry those historical issue links

#### Scenario: Demotion is gated on engine progress density

- **WHEN** the loop stream still lacks dense mid-item stage progress
- **THEN** the shared compact contract SHALL keep post-linkage advance follow mandatory
- **AND** a generated SKILL SHALL NOT demote it to optional-only wording

---

### Requirement: A drift-guard SHALL fail if post-linkage advance follow regresses to optional-only wording

Automated checks covered by `npm run ci` SHALL fail if `renderHostSkill()` or any generated host SKILL omits the compact post-linkage obligation to add `pipeline logs <advance-run-id> --events --follow` while retaining the loop follow, or describes it only as optional before the dense loop-progress requirement is met. The guard SHALL target the shared renderer and byte-identical outputs rather than host-specific §4b sections. A deliberate demotion after dense loop progress ships MAY update the renderer, docs, guard, and living spec together.

#### Scenario: Optional-only post-linkage wording fails the guard

- **WHEN** the shared renderer treats linked advance follow as optional-only after an advance id is published
- **THEN** the drift guard SHALL fail under `npm run ci`

#### Scenario: Pre-linkage optional absence remains allowed

- **WHEN** no advance id has been published
- **THEN** the guard SHALL permit loop-only follow and SHALL NOT require a guessed advance target

---

### Requirement: Host loop orchestration SHALL stop all run-scoped follows on terminal in the same turn

The compact shared loop contract and every generated host SKILL SHALL require same-turn teardown of the primary loop follow and every linked advance follow scoped to that loop when `loop_run_complete` or `loop_run_stopped` is observed, or when the supervisor exits. A supervisor exit without a confirmed terminal loop event SHALL be reported as non-terminal failure/recovery and SHALL NOT be treated as successful completion. The observer SHALL leave unrelated runs and host tools untouched. Durable docs MAY explain process and Monitor cleanup in detail; generated SKILLs SHALL NOT embed cleanup scripts.

#### Scenario: Same-turn stop on loop_run_stopped

- **WHEN** the followed loop emits a terminal event
- **THEN** the observer SHALL stop its loop follow and linked advance follow in the same turn

#### Scenario: Same-turn stop on supervisor process exit

- **WHEN** the loop supervisor exits
- **THEN** the observer SHALL stop follows scoped to that loop without waiting for an operator kill
- **AND** if terminal is not confirmed, it SHALL report non-terminal failure/recovery rather than completion

#### Scenario: Unrelated Monitors are out of scope

- **WHEN** terminal teardown runs
- **THEN** it SHALL NOT stop follows belonging to another loop, issue, or unrelated host tool

---

### Requirement: Documented dual-follow patterns SHALL exit the follow process on loop_run_stopped

If durable operator docs include a dual-follow or multi-stream script, that pattern SHALL exit successfully after observing `loop_run_complete` or `loop_run_stopped`, printing the final summary line, and stopping its run-scoped follows. It SHALL NOT continue an infinite loop after printing a terminal marker. Generated host SKILLs SHALL NOT be required to contain such a script.

#### Scenario: Dual-follow script exits after terminal

- **WHEN** a documented multi-stream example observes a terminal loop event
- **THEN** it SHALL print its final summary and exit 0
- **AND** it SHALL NOT continue a post-terminal `while true` loop

#### Scenario: One-pager carries behavior without the script

- **WHEN** a generated host SKILL is read
- **THEN** it SHALL require terminal teardown and summary
- **AND** it SHALL NOT be required to embed a FIFO or shell implementation

---

### Requirement: Final loop summary SHALL report terminal reason and that follows stopped

The compact shared loop contract and every generated host SKILL SHALL require, after a confirmed terminal loop event, a final summary containing the loop's terminal or stop reason and explicit confirmation that its run-scoped follows stopped. When the supervisor exits before terminal, it SHALL instead require a non-terminal failure/recovery report with follows-stopped confirmation and SHALL forbid presenting that report as a completed-loop summary. Durable operator docs MAY define additional audit or result fields. The follower SHALL report any operator-authorized merge next step without invoking a merge-capable command.

#### Scenario: Completed-loop summary includes both fields

- **WHEN** a loop reaches a confirmed terminal event
- **THEN** the final summary SHALL include terminal reason and follows-stopped confirmation

#### Scenario: Summary does not escalate authority

- **WHEN** a terminal summary identifies a merge-capable next step
- **THEN** the follower SHALL leave that step to an explicitly authorized operator surface

---

### Requirement: A drift-guard SHALL fail if stop-on-terminal loop follow guidance is weakened

Automated checks covered by `npm run ci` SHALL fail if `renderHostSkill()` or any generated host SKILL drops same-turn stop of loop and linked-advance follows on terminal/supervisor exit, confirmed-terminal reason and follows-stopped summary, premature-exit-is-non-terminal failure/recovery, or the until-terminal behavior of `pipeline loop logs <loop-run-id> --events --follow`. If durable docs contain a multi-stream example, a docs guard SHALL reject an infinite post-terminal pattern. The checks SHALL target shared rendered output and durable docs rather than a host-specific §4b section.

#### Scenario: Missing stop-on-terminal language fails the guard

- **WHEN** the shared renderer no longer requires same-turn run-scoped follow teardown
- **THEN** the drift guard SHALL fail

#### Scenario: Unconditional no-auto-exit one-liner fails the guard

- **WHEN** primary docs claim unconditional no-auto-exit for `pipeline loop logs ... --follow` without documenting its until-terminal behavior
- **THEN** the documentation guard SHALL fail

#### Scenario: Infinite durable example fails

- **WHEN** a documented multi-stream example continues after terminal observation
- **THEN** the documentation guard SHALL fail without requiring that example in a generated SKILL

---

### Requirement: Generated loop skill packaging SHALL share host-neutral notify and linked-follow guidance

Claude, Codex, Grok, and OpenCode SHALL receive byte-identical generated SKILLs containing the same compact loop and linked-advance follow contract plus the full compact host-notify map. The active host SHALL select its map row; shared loop prose SHALL NOT hard-require another host's tool. Grok's existing `symlink-claude` lifecycle MAY consume the same bytes without a divergent Grok SKILL implementation.

#### Scenario: Existing Claude and Codex loop contracts remain

- **WHEN** the generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** their loop follow, linked-follow, terminal teardown, and notify-map text SHALL be byte-identical

#### Scenario: Grok-consumed loop section uses host map

- **WHEN** Grok consumes the shared generated one-pager
- **THEN** material progress SHALL use Grok's `monitor` row or documented equivalent
- **AND** Grok SHALL NOT be required to call Claude `PushNotification`

#### Scenario: Host identity does not fork loop behavior

- **WHEN** any generated host executes loop orchestration
- **THEN** it SHALL use the same two CLI follow forms and terminal contract
- **AND** only the selected notify-map row SHALL vary at runtime

---

### Requirement: Default loop orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

The shared one-pager renderer SHALL express default loop orchestration through portable durable handoff with retained `loop_run_id`, retained linked `advance_run_id`, loop and linked-advance logs follow, material filtering, interrupted-follow re-attach, terminal-or-exit teardown, confirmed-terminal final summary, premature-exit non-terminal failure/recovery, and the compact host-notify map. The generated host files SHALL remain byte-identical and SHALL NOT encode lifecycle dispatch as equality checks against a closed host set. A supported outer host outside `SKILL_HOST_IDS` SHALL use the same lifecycle through durable operator guidance and its manifest-declared mapping or fallback without implicitly gaining a generated row or target.

#### Scenario: Capability-driven loop supervision applies without host-name switch

- **WHEN** a supported outer host provides the declared lifecycle operations or documented fallbacks
- **THEN** the shared contract SHALL require retained handoff/linkage ids, both applicable follow commands, re-attach, terminal-or-exit cleanup, confirmed-terminal final summary, and premature-exit failure/recovery
- **AND** material notification SHALL use the selected host-map row when the
  host is in `SKILL_HOST_IDS`, otherwise its manifest-declared mapping or fallback

#### Scenario: Loop material notify uses manifest mapping

- **WHEN** loop orchestration surfaces material progress
- **THEN** it SHALL use the active outer host's notify-map row or declared fallback
- **AND** shared prose SHALL NOT hard-require one host's notify tool on every host
