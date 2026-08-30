# advance-skill-orchestration Specification

## Purpose
TBD - created by archiving change advance-follow-reattach-until-terminal. Update Purpose after archive.
## Requirements
### Requirement: Single-issue advance host packaging SHALL specify detach, follow, re-attach, stop, and summarize

`core/scripts/host-skill.ts` and every generated host SKILL SHALL carry the same compact, ordered protocol for default numeric `pipeline <N>` and for `pipeline single`. This packaging change SHALL NOT alter CLI dispatch: `pipeline <N>` remains a direct advance and `pipeline single` remains the durable loop path. The harness SHALL perform the status pre-check. For `pipeline <N>` it SHALL retain `advance_run_id` from the advance handoff and follow `pipeline logs <advance-run-id> --events --follow`. For `pipeline single` it SHALL retain `loop_run_id` from the durable handoff and follow `pipeline loop logs <loop-run-id> --events --follow`; after `loop_item_advance_linked` publishes `pipeline_run_id`, it SHALL retain that value as the linked `advance_run_id` and also follow `pipeline logs <advance-run-id> --events --follow`. It SHALL notify only material events through the active host-notify row, re-attach interrupted live follows using those retained ids, stop only the matching advance follow on advance `run_complete` while keeping a still-live loop follow, stop the loop-scoped follow set on `loop_run_complete`, `loop_run_stopped`, or supervisor exit, and emit the final summary after a confirmed terminal outcome for that drive. A supervisor exit before terminal SHALL be reported as a non-terminal failure/recovery condition, never as completion. Detailed launch, recovery, and summary examples SHALL live in durable operator docs linked by the one-pager instead of in host-specific §4 scripts. The follower SHALL NOT treat detach as fire-and-forget, infer either run id through `pipeline status`, or invoke a merge-capable command.

#### Scenario: Ordered advance orchestration steps are present

- **WHEN** an operator reads any generated host SKILL
- **THEN** it SHALL list status pre-check, direct-numeric advance follow via retained `advance_run_id`, loop/single follow via retained `loop_run_id`, retained linked `advance_run_id` after linkage, material notify, re-attach, advance-only teardown on `run_complete`, loop-scoped teardown on loop terminal or supervisor exit, and confirmed-terminal final summary as compact ordered obligations
- **AND** it SHALL NOT instruct the host to treat default advance as fire-and-forget
- **AND** it SHALL classify premature supervisor exit as non-terminal failure/recovery rather than completion
- **AND** it SHALL NOT claim that `pipeline <N>` yields `loop_run_id`

#### Scenario: Generated advance guidance stays a byte-identical one-pager

- **WHEN** the generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** their advance protocol SHALL be byte-identical
- **AND** none SHALL contain a host-specific §4 bash discovery or recovery script

#### Scenario: The observer does not escalate into merge authority

- **WHEN** the generated advance protocol describes follow or terminal handoff
- **THEN** it SHALL state that the follower or observer does not invoke `merge`, `merge-queue --apply`, `train --merge`, or `ship`

---

### Requirement: Host advance orchestration SHALL re-attach after cancelled or lost follow before terminal

The shared one-pager renderer and every generated host SKILL SHALL state that cancellation, interruption, timeout, or loss of either default-drive follow before terminal is non-terminal. The harness SHALL use the retained handoff `loop_run_id` to re-arm `pipeline loop logs <loop-run-id> --events --follow` when the loop remains live and each retained `advance_run_id` to re-arm `pipeline logs <advance-run-id> --events --follow` when that advance remains live. It SHALL emit a completed-run summary only when a terminal outcome for that drive is already confirmed. If the supervisor exits before terminal, the harness SHALL stop all run-scoped follows in the same turn and report a non-terminal failure/recovery condition. Detailed liveness signals and recovery examples SHALL live in durable operator docs. Neither the shared renderer nor those docs SHALL present an informal `/tmp/pipeline-*.log` file or `pipeline status <N>` as the source of either run id.

#### Scenario: Cancelled event wait re-arms follow in the same turn

- **WHEN** a default-drive loop or linked-advance follow ends before its run is terminal
- **AND** the corresponding durable run remains live
- **THEN** the compact contract SHALL require re-arming the correct loop or advance logs-follow command with the same retained `loop_run_id` or `advance_run_id`

#### Scenario: Lost wait after run already finished still requires terminal summary

- **WHEN** a follow ends after the durable loop has already become terminal
- **THEN** the compact contract SHALL require a final summary and ending every remaining loop and linked-advance follow scoped to that drive

#### Scenario: Re-attach uses run-store id not informal tmp logs

- **WHEN** the compact contract or durable docs describe default-drive re-attach
- **THEN** they SHALL target the retained `loop_run_id` with `pipeline loop logs <loop-run-id> --events --follow` and each retained linked `advance_run_id` with `pipeline logs <advance-run-id> --events --follow`
- **AND** they SHALL NOT use an informal temporary log as the evidence contract or embed a host-specific recovery script
- **AND** they SHALL NOT claim `pipeline status <N>` discovers either run id

---

### Requirement: Host advance orchestration SHALL treat cancelled wait as non-terminal

The shared one-pager renderer and every generated host SKILL SHALL state compactly that a cancelled, interrupted, or timed-out follow is not a terminal pipeline outcome. A supervisor exit also SHALL NOT prove terminal state: the harness SHALL tear down all run-scoped follows on exit, but when no terminal outcome for that drive is confirmed it SHALL report non-terminal failure/recovery rather than completion. Successful loop supervision SHALL end only after the retained loop run is confirmed terminal. Successful direct-advance supervision SHALL end after that advance `run_complete`. Durable operator docs MAY describe an explicit operator decision to abandon observation of a live run, but the generated contract SHALL NOT present loss of the wait or premature supervisor exit as completion.

#### Scenario: Cancelled wait is not stop-watching

- **WHEN** a generated host SKILL describes advance follow recovery
- **THEN** it SHALL state that an interrupted follow is non-terminal
- **AND** it SHALL require re-attach or a confirmed-terminal summary

#### Scenario: Default path forbids silent stop after interrupt

- **WHEN** a host follow tool is cancelled before a terminal pipeline event
- **THEN** the shared contract SHALL NOT equate that host-tool result with pipeline completion
- **AND** a premature supervisor exit SHALL produce a non-terminal failure/recovery report after run-scoped follow teardown

---

### Requirement: Final advance summary SHALL remain mandatory after terminal follow

The shared one-pager renderer and every generated host SKILL SHALL require a final operator summary after a confirmed terminal outcome for that drive: loop terminal plus same-turn teardown of the loop and all linked-advance follows, or direct-advance `run_complete` plus teardown of that advance follow. Durable operator docs SHALL define the detailed summary fields, including starting-to-ending stage, elapsed time or transitions when available, PR URL when present, terminal state, and the operator-authorized merge next step. A premature supervisor exit SHALL instead produce a non-terminal failure/recovery report after teardown. The follower SHALL report merge as a next step and SHALL NOT invoke a merge-capable command.

#### Scenario: Terminal handoff includes summary and stop follows

- **WHEN** the retained default-drive loop reaches a terminal loop event
- **THEN** the compact contract SHALL require a final summary and stopping its loop and linked-advance follows in the same turn
- **AND** when only a direct numeric advance is live, advance `run_complete` SHALL stop that advance follow without requiring a loop terminal

#### Scenario: Durable docs define the detailed handoff

- **WHEN** the final advance summary is produced
- **THEN** durable operator docs SHALL require terminal state and PR URL when present
- **AND** they SHALL describe merge as an operator-authorized next step rather than an observer action

---

### Requirement: A drift-guard SHALL fail if advance re-attach guidance is weakened

Automated checks covered by `npm run ci` SHALL compare every generated host SKILL with `renderHostSkill()` and fail if the shared compact default-drive contract or generated output drops retained handoff `loop_run_id`, `pipeline loop logs <loop-run-id> --events --follow`, retained linked `advance_run_id`, `pipeline logs <advance-run-id> --events --follow`, interrupted-follow-is-non-terminal, re-attach by retained id, teardown on terminal or supervisor exit, premature-exit-is-not-completion, confirmed-terminal final summary, or the follower merge prohibition. A checked-in documentation guard SHALL also fail if durable recovery docs claim status discovers a run id or drop either retained-id follow path and the terminal summary/audit path. The guards SHALL target the shared renderer and durable docs rather than requiring host-specific §4 prose.

#### Scenario: Missing re-attach language fails the guard

- **WHEN** `renderHostSkill()` no longer emits retained-id re-attach after interrupted loop or linked-advance follow, or terminal/exit teardown and confirmed-terminal summary
- **THEN** the drift guard SHALL fail under `npm run ci`

#### Scenario: Missing cancelled-wait-is-not-terminal language fails the guard

- **WHEN** the shared renderer or generated output no longer states that an interrupted follow is non-terminal
- **THEN** the advance drift guard SHALL fail

#### Scenario: Missing re-attach command path fails the guard

- **WHEN** the durable operator docs no longer contain status as issue metadata, both retained-id logs-follow forms, and a confirmed-terminal summary/audit path
- **THEN** the documentation guard SHALL fail without requiring the recovery essay in each generated SKILL

---

### Requirement: Default advance orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

The shared one-pager renderer SHALL express default numeric orchestration through the portable advance handoff and advance logs-follow, and default single/loop orchestration through the portable loop handoff, primary loop logs-follow, linked-advance logs-follow after linkage, material-event filter, terminal/exit contract, and compact host-notify map. This SHALL NOT change CLI dispatch. The generated Claude, Codex, Grok, and OpenCode SKILLs SHALL remain byte-identical; selecting one of those four rows SHALL NOT fork the lifecycle prose or add a closed host-name dispatch branch. A supported outer host outside `SKILL_HOST_IDS` SHALL consume the same lifecycle contract through durable operator guidance and its manifest-declared notify mapping or fallback; it SHALL NOT gain a generated row or target implicitly. The one-pager retains the runtime obligations to retain both ids, follow, re-attach, notify, stop, summarize only confirmed terminal, report premature exit as non-terminal failure/recovery, and clean up.

#### Scenario: Capability-driven advance steps apply to a non-built-in host

- **WHEN** a supported outer host runs default advance orchestration
- **THEN** it SHALL use the same retained ids for the applicable drive (`advance_run_id` for direct numeric; `loop_run_id` plus linked `advance_run_id` for single/loop), applicable follow and re-attach commands, terminal/exit cleanup, premature-exit failure reporting, and confirmed-terminal summary contract
- **AND** if the host is outside `SKILL_HOST_IDS`, material notification SHALL
  use its manifest-declared mapping or fallback without adding a compact-map row
  or generated SKILL target

#### Scenario: Closed reattach behavior is a contract fixture not a host table

- **WHEN** regression coverage checks interrupted-follow re-attach
- **THEN** it SHALL assert the shared portable lifecycle contract
- **AND** it SHALL NOT implement the requirement only as a table of built-in host names or divergent SKILL prose

### Requirement: Durable operator docs SHALL document the default-drive re-attach path

`docs/cli.md` and/or `docs/packaging.md` SHALL document the complete operator recovery path using retained durable handoff identifiers: `pipeline status <N>` MAY report issue stage, blocker, and PR but SHALL NOT be presented as run-id discovery; a direct numeric advance handoff `run_id` is retained as `<advance-run-id>` and drives `pipeline logs <advance-run-id> --events --follow`; the loop/single handoff `loop_run_id` drives `pipeline loop logs <loop-run-id> --events --follow`; each `loop_item_advance_linked` event's `pipeline_run_id` value is retained as `<advance-run-id>` and drives `pipeline logs <advance-run-id> --events --follow`; and the applicable summary/audit surface follows confirmed terminal. The generated one-pager SHALL carry both exact follow forms and durable links to those docs, but SHALL NOT be required to restate the recovery essay.

#### Scenario: Re-attach path is concrete and copyable

- **WHEN** an operator follows the advance recovery documentation
- **THEN** it SHALL provide the status, loop logs-follow, linked-advance logs-follow, and terminal summary/audit forms with `<N>`, `<loop-run-id>`, and `<advance-run-id>` placeholders
- **AND** it SHALL source those run ids from durable handoff/linkage evidence instead of status or an informal temporary log path

#### Scenario: The one-pager points to recovery detail

- **WHEN** a generated host SKILL is installed outside the repository
- **THEN** it SHALL retain a usable durable link to the operator docs
- **AND** its compact contract SHALL still name both `pipeline loop logs <loop-run-id> --events --follow` and `pipeline logs <advance-run-id> --events --follow`

---

