## MODIFIED Requirements

### Requirement: Single-issue advance host packaging SHALL specify detach, follow, re-attach, stop, and summarize

`core/scripts/host-skill.ts` and every generated host SKILL SHALL carry the same compact, ordered protocol for default numeric `pipeline <N>` and for `pipeline single`. Mutating `pipeline <N>` SHALL be the durable one-item drive, the same lifecycle as `pipeline single`. The harness SHALL perform the status pre-check. For `pipeline <N>` and `pipeline single` it SHALL retain `loop_run_id` from the durable loop handoff and follow `pipeline loop logs <loop-run-id> --events --follow`; after `loop_item_advance_linked` publishes `pipeline_run_id`, it SHALL retain that value as the linked `advance_run_id` and also follow `pipeline logs <advance-run-id> --events --follow`. It SHALL notify only material events through the active host-notify row, re-attach interrupted live follows using those retained ids, stop only the matching advance follow on advance `run_complete` while keeping a still-live loop follow, stop the loop-scoped follow set on `loop_run_complete`, `loop_run_stopped`, or supervisor exit, and emit the final summary after a confirmed terminal outcome for that drive. A supervisor exit before terminal SHALL be reported as a non-terminal failure/recovery condition, never as completion. Detailed launch, recovery, and summary examples SHALL live in durable operator docs linked by the one-pager instead of in host-specific §4 scripts. The follower SHALL NOT treat detach as fire-and-forget, infer either run id through `pipeline status`, recommend a raw-advance bypass, or invoke a merge-capable command.

#### Scenario: Ordered advance orchestration steps are present

- **WHEN** an operator reads any generated host SKILL
- **THEN** it SHALL list status pre-check, numeric and single launch as the durable one-item drive, loop/single follow via retained `loop_run_id`, retained linked `advance_run_id` after linkage, material notify, re-attach, advance-only teardown on `run_complete`, loop-scoped teardown on loop terminal or supervisor exit, and confirmed-terminal final summary as compact ordered obligations
- **AND** it SHALL NOT instruct the host to treat default advance as fire-and-forget
- **AND** it SHALL classify premature supervisor exit as non-terminal failure/recovery rather than completion
- **AND** it SHALL treat mutating `pipeline <N>` as yielding `loop_run_id`
- **AND** it SHALL NOT recommend a raw-advance bypass for issue drive

#### Scenario: Generated advance guidance stays a byte-identical one-pager

- **WHEN** the generated Claude, Codex, Grok, and OpenCode SKILLs are compared
- **THEN** their advance protocol SHALL be byte-identical
- **AND** none SHALL contain a host-specific §4 bash discovery or recovery script

#### Scenario: The observer does not escalate into merge authority

- **WHEN** the generated advance protocol describes follow or terminal handoff
- **THEN** it SHALL state that the follower or observer does not invoke `merge`, `merge-queue --apply`, `train --merge`, or `ship`

---

### Requirement: Default advance orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

The shared one-pager renderer SHALL express default numeric and single/loop orchestration through the portable loop handoff, primary loop logs-follow, linked-advance logs-follow after linkage, material-event filter, terminal/exit contract, and compact host-notify map. Mutating `pipeline <N>` SHALL use that same loop contract; it SHALL NOT keep a separate direct-advance follow identity. The generated Claude, Codex, Grok, and OpenCode SKILLs SHALL remain byte-identical; selecting one of those four rows SHALL NOT fork the lifecycle prose or add a closed host-name dispatch branch. A supported outer host outside `SKILL_HOST_IDS` SHALL consume the same lifecycle contract through durable operator guidance and its manifest-declared notify mapping or fallback; it SHALL NOT gain a generated row or target implicitly. The one-pager retains the runtime obligations to retain both ids, follow, re-attach, notify, stop, summarize only confirmed terminal, report premature exit as non-terminal failure/recovery, and clean up.

#### Scenario: Capability-driven advance steps apply to a non-built-in host

- **WHEN** a supported outer host runs default advance orchestration
- **THEN** it SHALL use the same retained ids for the default issue drive (`loop_run_id` plus linked `advance_run_id` after linkage), applicable follow and re-attach commands, terminal/exit cleanup, premature-exit failure reporting, and confirmed-terminal summary contract
- **AND** if the host is outside `SKILL_HOST_IDS`, material notification SHALL
  use its manifest-declared mapping or fallback without adding a compact-map row
  or generated SKILL target

#### Scenario: Closed reattach behavior is a contract fixture not a host table

- **WHEN** regression coverage checks interrupted-follow re-attach
- **THEN** it SHALL assert the shared portable lifecycle contract
- **AND** it SHALL NOT implement the requirement only as a table of built-in host names or divergent SKILL prose

---

### Requirement: Durable operator docs SHALL document the default-drive re-attach path

`docs/cli.md` and/or `docs/packaging.md` SHALL document the complete operator recovery path using retained durable handoff identifiers: `pipeline status <N>` MAY report issue stage, blocker, and PR but SHALL NOT be presented as run-id discovery; mutating `pipeline <N>` and `pipeline single` retain the loop handoff `loop_run_id` and drive `pipeline loop logs <loop-run-id> --events --follow`; each `loop_item_advance_linked` event's `pipeline_run_id` value is retained as `<advance-run-id>` and drives `pipeline logs <advance-run-id> --events --follow`; and the applicable summary/audit surface follows confirmed terminal. The generated one-pager SHALL carry both exact follow forms and durable links to those docs, but SHALL NOT be required to restate the recovery essay. Durable docs SHALL NOT present a top-level `advance_run_handoff` as the canonical identity of public numeric drive.

#### Scenario: Re-attach path is concrete and copyable

- **WHEN** an operator follows the advance recovery documentation
- **THEN** it SHALL provide the status, loop logs-follow, linked-advance logs-follow, and terminal summary/audit forms with `<N>`, `<loop-run-id>`, and `<advance-run-id>` placeholders
- **AND** it SHALL source those run ids from durable handoff/linkage evidence instead of status or an informal temporary log path

#### Scenario: The one-pager points to recovery detail

- **WHEN** a generated host SKILL is installed outside the repository
- **THEN** it SHALL retain a usable durable link to the operator docs
- **AND** its compact contract SHALL still name both `pipeline loop logs <loop-run-id> --events --follow` and `pipeline logs <advance-run-id> --events --follow`

---

### Requirement: Final advance summary SHALL remain mandatory after terminal follow

The shared one-pager renderer and every generated host SKILL SHALL require a final operator summary after a confirmed terminal outcome for that drive: loop terminal plus same-turn teardown of the loop and all linked-advance follows. Durable operator docs SHALL define the detailed summary fields, including starting-to-ending stage, elapsed time or transitions when available, PR URL when present, terminal state, and the operator-authorized merge next step. A premature supervisor exit SHALL instead produce a non-terminal failure/recovery report after teardown. The follower SHALL report merge as a next step and SHALL NOT invoke a merge-capable command. Public numeric drive SHALL use this loop-terminal summary; it SHALL NOT complete observation on a child `run_complete` while the one-item supervisor remains live.

#### Scenario: Terminal handoff includes summary and stop follows

- **WHEN** the retained default-drive loop reaches a terminal loop event
- **THEN** the compact contract SHALL require a final summary and stopping its loop and linked-advance follows in the same turn
- **AND** mutating `pipeline <N>` SHALL use that same loop-terminal contract rather than completing on a child advance `run_complete` alone

#### Scenario: Durable docs define the detailed handoff

- **WHEN** the final advance summary is produced
- **THEN** durable operator docs SHALL require terminal state and PR URL when present
- **AND** they SHALL describe merge as an operator-authorized next step rather than an observer action
