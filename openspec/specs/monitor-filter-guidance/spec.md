# monitor-filter-guidance Specification

## Purpose
TBD - created by archiving change tighten-skillmd-monitor-filter. Update Purpose after archive.

## Requirements

### Requirement: Run-store event follow SHALL be the primary host monitoring contract

`core/scripts/host-skill.ts` and every generated host SKILL SHALL use structured run-store event follow as the primary monitoring contract. The default numeric `pipeline <N>` path and the `pipeline single` / `pipeline loop` path SHALL retain the handoff `loop_run_id` and follow `pipeline loop logs <loop-run-id> --events --follow`; after `loop_item_advance_linked`, they SHALL retain that event's `pipeline_run_id` value as `advance_run_id` and also follow `pipeline logs <advance-run-id> --events --follow`. Public numeric drive SHALL NOT use a top-level `advance_run_handoff` as its canonical follow identity. The compact contract SHALL direct human-visible progress from the applicable streams through the shared material filter or an equivalent `--material` surface. It SHALL NOT recommend the broad stdout alternation `"^\[pipeline\]|^\[exit code|FAILED|timed out|blocked label|approved|needs-attention|→ "` as the primary filter. Durable docs MAY retain the legacy issue-scoped stdout grep `^\[pipeline\] #<N>: ` as a diagnostic for legacy logs, but each generated one-pager SHALL carry only the structured retained-id follow guidance and a durable-doc pointer.

#### Scenario: Tight filter used in Monitor command

- **WHEN** an operator arms a host follow for a default numeric drive
- **THEN** the compact one-pager SHALL name the retained-id loop command and the shared material filter
- **AND** it SHALL NOT recommend the broad stdout alternation as the primary filter
- **AND** after linkage it SHALL also name the retained-id linked-advance command
- **AND** it SHALL NOT present a top-level `advance_run_handoff` as the canonical numeric identity

#### Scenario: Concrete substitution example provided

- **WHEN** the compact contract or durable docs show a structured follow example
- **THEN** the example SHALL use an explicit `<loop-run-id>` / `<advance-run-id>` or concrete retained durable ids
- **AND** it SHALL distinguish primary `pipeline loop logs` from linked-advance `pipeline logs`
- **AND** it SHALL NOT claim `pipeline status <N>` discovers either id

### Requirement: Durable docs SHALL explain material filtering and notification-spam suppression

Durable operator docs SHALL explain why human-visible progress uses the shared material filter while unfiltered `events.jsonl` remains the complete evidence stream. The explanation SHALL preserve the legacy rationale: test-gate output can contain fixture transitions for unrelated issue numbers, broad stdout matching can surface those false positives, and rapid duplicate notifications can hit a host Monitor's auto-stop or attention threshold. It SHALL also explain the current structured suppression rules defined by the shared filter. Generated host SKILLs SHALL point to those docs and SHALL NOT repeat the fixture-spam or auto-stop essay.

#### Scenario: Test-gate fixture spam explained

- **WHEN** an operator reads the durable material-filter rationale
- **THEN** it SHALL explain that test output can reproduce transition-looking fixture lines for unrelated issues
- **AND** it SHALL explain why structured run events plus the shared material filter avoid treating those lines as progress

#### Scenario: Auto-stop risk explained

- **WHEN** an operator reads the durable spam-suppression guidance
- **THEN** it SHALL explain that bursts of duplicate progress can overwhelm or auto-stop a host notification surface
- **AND** the generated one-pager SHALL retain only the compact material-notify rule and durable-doc pointer

---

### Requirement: Run-store event follow SHALL preserve terminal and diagnostic evidence

The shared follow/notify contract SHALL require follow-until-terminal over the retained loop run-store stream, add the retained linked-advance stream after linkage, and perform same-turn teardown of all run-scoped follows after a terminal event or any supervisor/process exit. A supervisor exit before terminal SHALL be reported as non-terminal failure/recovery and SHALL NOT be presented as completion. The contract SHALL treat the material filter as a human-visible notification projection, never as a replacement for unfiltered events. Durable docs SHALL state that unfiltered `pipeline loop logs <loop-run-id> --events --follow`, `pipeline logs <advance-run-id> --events --follow`, or raw `events.jsonl` remains available for full diagnostic evidence. Generated SKILLs SHALL NOT be required to prove terminal capture through a legacy `[pipeline] #N:` stdout-transition essay.

#### Scenario: Terminal transitions confirmed captured

- **WHEN** an operator follows a default-drive loop and any linked advance stream
- **THEN** the compact contract SHALL require observation through a terminal loop event and then stop every run-scoped follow
- **AND** durable docs SHALL identify the unfiltered event stream as the complete transition evidence

#### Scenario: Process-exit signal described

- **WHEN** a durable supervisor or followed process exits
- **THEN** the compact stop contract SHALL treat that exit as a stop condition alongside terminal events
- **AND** it SHALL NOT require a final stdout line to prove completion
- **AND** absent a confirmed terminal loop event, it SHALL report non-terminal failure/recovery rather than completion

---

### Requirement: Generated hosts SHALL share one compact event-follow contract

`hosts/claude/SKILL.md`, `hosts/codex/SKILL.md`, `hosts/grok/SKILL.md`, and `hosts/opencode/SKILL.md` SHALL be byte-identical generated one-pagers containing the same retained `loop_run_id` and linked `advance_run_id` event-follow commands, material-filter obligation, durable-doc pointer, premature-exit failure/recovery rule, and compact host-notify map. Material-event membership and spam suppression SHALL come from the shared filter, while the active host selects only its notify-map row. No generated surface SHALL carry the broad stdout alternation or a host-specific material-kind inventory. The generator SHALL NOT write a plugin SKILL overlay to carry this contract.

#### Scenario: Claude host filter matches spec

- **WHEN** `hosts/claude/SKILL.md` is read
- **THEN** it SHALL carry the shared compact event-follow and material-filter contract
- **AND** it SHALL NOT carry a Claude-specific event inventory or broad stdout filter

#### Scenario: Codex host filter matches spec

- **WHEN** `hosts/codex/SKILL.md` is read
- **THEN** its follow/filter bytes SHALL match the generated Claude one-pager
- **AND** only runtime selection of the Codex notify-map row SHALL differ

#### Scenario: Plugin SKILL.md filter matches spec

- **WHEN** `scripts/build.mjs` runs
- **THEN** it SHALL NOT write `plugin/pipeline/skills/pipeline/SKILL.md`
- **AND** the four generated host SKILLs SHALL remain the compact filter surfaces
- **AND** no plugin overlay SHALL restore the retired per-host filter essay

### Requirement: Shared renderer and durable docs SHALL document the events.jsonl material filter for progress notify

`core/scripts/material-filter.ts` SHALL remain the executable single source for human-visible progress selection. Durable operator docs SHALL name that filter, enumerate or generate the complete advance and loop material-kind and spam-suppression inventories from its exported constants, and state that unfiltered run-store events remain authoritative evidence. `core/scripts/host-skill.ts` and each generated one-pager SHALL carry only the compact obligation to apply the shared material filter while following the retained-id primary loop command and, after linkage, the retained-id advance command, notify through the active host-map row, and follow the durable doc link. They SHALL NOT reproduce the full inventory.

#### Scenario: Material filter is named in host skill monitoring guidance

- **WHEN** an operator reads any generated host SKILL
- **THEN** it SHALL name the shared material filter or an equivalent material mode composed with structured event follow
- **AND** it SHALL point to durable docs for the material-kind and suppression details

#### Scenario: Unfiltered evidence path remains available

- **WHEN** an operator needs full lifecycle evidence rather than notification bubbles
- **THEN** durable docs SHALL allow unfiltered advance or loop logs follow and raw `events.jsonl`
- **AND** they SHALL state that the material filter does not replace or rewrite the run store

---

### Requirement: Shared filter and durable docs SHALL own one material-event inventory

The full advance and loop notification inventories SHALL live in `core/scripts/material-filter.ts` and matching durable operator docs, not in each generated SKILL. The advance inventory SHALL match `ADVANCE_MATERIAL_KINDS`: `run_start`, `stage_start`, `stage_complete`, `pr_created`, `pr_updated`, `review_verdict`, `gate_result`, `blocker_set`, `blocker_cleared`, and `run_complete`. The required loop inventory SHALL match `LOOP_MATERIAL_KINDS`: `loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, `loop_item_advance_linked`, `loop_item_advance_finished`, `loop_item_stage_progress`, `loop_item_progress`, `loop_run_stopped`, and `loop_run_complete`. The optional burst-suppressed loop inventory SHALL match `LOOP_OPTIONAL_MATERIAL_KINDS`: `loop_schedule_evaluated`, `loop_reconciled`, `loop_merge_barrier_cleared`, `loop_item_paused`, `loop_item_waiting`, `loop_item_resumed`, `loop_item_abandoned`, `loop_item_skipped`, `loop_item_precondition_excluded`, `loop_recovery_attempt`, and `loop_run_superseded`.

The shared filter and durable docs SHALL also agree on all suppression rules: skipped gate lifecycles are omitted; repeated identical CI `partial` events collapse; `openspec_archive` `skipped` progress is omitted; only the first CI `waiting` event in a stretch surfaces; repeated identical definitive `loop_item_progress` results collapse; and repeated identical optional schedule/reconcile events collapse. Definitive loop-progress statuses SHALL match the exported inventory (`pass`, `fail`, `approve`, `needs_attention`, `attempted`, `success`, `exhausted`, `blocked`, `advanced`, and `started`). Generated one-pagers SHALL contain one compact pointer/obligation and SHALL remain byte-identical; only runtime notify-map row selection differs.

#### Scenario: Claude and Codex share material kinds

- **WHEN** the generated Claude and Codex one-pagers are compared
- **THEN** both SHALL point to the same shared material filter and durable inventory
- **AND** neither SHALL duplicate or fork the material-kind and suppression lists

#### Scenario: Grok path matches the shared material set

- **WHEN** Grok consumes the generated one-pager
- **THEN** it SHALL use the same shared material filter and durable inventory
- **AND** material lines SHALL surface through the Grok notify-map row rather than a Grok-specific kind list

#### Scenario: Durable inventory matches every shared filter constant

- **WHEN** the advance, required-loop, optional-loop, definitive-status, and suppression inventories are compared between code and durable docs
- **THEN** every exported entry and suppression rule SHALL match
- **AND** a drift guard covered by `npm run ci` SHALL fail on omission or divergence
