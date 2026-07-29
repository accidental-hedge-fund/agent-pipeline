## ADDED Requirements

### Requirement: `pipeline:loop` packaging SHALL NOT claim seconds-only runs or forbid Monitor

Host packaging for multi-item drive and resume of `pipeline:loop` SHALL treat the
operation as long-running. Generated Claude command docs, the single-source
operation-surface renderer that produces them, and host skill guidance for drive
and resume SHALL NOT claim that the command “completes in seconds” and SHALL NOT
instruct harnesses that “no background process or Monitor is needed.” Read-only
`--audit` MAY remain documented as a short synchronous mode.

#### Scenario: Generated loop command omits the fast-path falsehood

- **WHEN** `scripts/build.mjs` renders the Claude command for the `loop` operation
- **THEN** the rendered body SHALL NOT contain the substring “completes in seconds”
  (case-insensitive)
- **AND** the rendered body SHALL NOT contain the substring “No background process
  or Monitor needed” (case-insensitive)

#### Scenario: Plugin command mirror matches the long-running classification

- **WHEN** the generated `plugin/pipeline/commands/pipeline:loop.md` is inspected
  after a successful build
- **THEN** it SHALL omit the seconds-only / no-Monitor fast-path phrases
- **AND** it SHALL state that multi-item drive or resume is long-running or requires
  event following

#### Scenario: Audit mode stays synchronous

- **WHEN** host or command docs describe `pipeline:loop --audit`
- **THEN** they MAY document that mode as read-only and seconds-long
- **AND** they SHALL NOT use that audit guidance as the orchestration rule for
  drive or resume

---

### Requirement: Loop orchestration docs SHALL specify handoff, follow, notify, stop, and summarize

Host skill guidance for `pipeline:loop` drive and resume (Claude and Codex) SHALL specify an ordered harness orchestration protocol:

1. Start or resume the loop.
2. Parse an early handoff carrying at least `run_id` and a loop events path when
   present; otherwise obtain `run_id` from the invocation / printed result and
   resolve the loop events path from the documented state-home layout.
3. Follow the loop event stream (persistent Monitor or host-equivalent follow).
4. Optionally follow an active item’s advance event stream when that advance
   `run_id` is published.
5. Stop following on a terminal loop outcome (including `loop_run_stopped`) or
   supervisor process exit.
6. Print a final summary (including `pipeline:loop --audit` or the documented
   summary surface).

#### Scenario: Ordered steps are present in host skill guidance

- **WHEN** an operator reads the loop orchestration section of `hosts/claude/SKILL.md`
  or `hosts/codex/SKILL.md`
- **THEN** the text SHALL list start/resume, handoff/`run_id`+events path, event
  follow, stop on terminal outcome or process exit, and summary/`--audit` as
  ordered steps

#### Scenario: Optional item-advance follow is not required before linkage exists

- **WHEN** no advance `run_id` has been published for the active item
- **THEN** the harness SHALL still follow the loop event stream
- **AND** the docs SHALL NOT require a non-existent advance-linkage field

---

### Requirement: Material loop event kinds SHALL be listed for harness notifications

Loop orchestration guidance SHALL list material loop event kinds that warrant a
harness notification or Push. The must-notify set SHALL include at least
`loop_item_started`, `loop_item_transitioned`, `loop_item_blocked`, and
`loop_run_stopped`. The guidance SHALL also name schedule and reconcile event
kinds that are appropriate to surface without requiring a notification on every
identical repeated evaluation in a polling burst.

#### Scenario: Must-notify kinds are named

- **WHEN** an operator reads the material-events list in host skill guidance
- **THEN** the list SHALL include `loop_item_started`, `loop_item_transitioned`,
  `loop_item_blocked`, and `loop_run_stopped`

#### Scenario: Burst suppression is documented

- **WHEN** the guidance describes schedule or reconcile notifications
- **THEN** it SHALL instruct harnesses to suppress repeated identical evaluations
  in the same burst rather than notify on every identical line

---

### Requirement: Docs SHALL provide an interim loop events follow path without forbidding monitoring

Loop orchestration docs SHALL document following the loop store event log at
`<state-home>/runs/<run_id>/events.jsonl` as the interim path until a dedicated
loop logs-follow CLI is universally available, including the state-home
resolution order (explicit Pipeline state-home override, then XDG state
directory under `agent-pipeline/loop`, then the home-relative default). The docs
SHALL NOT forbid Monitor or background following while waiting for a future CLI.
When a loop logs CLI exists, docs MAY prefer it and SHALL keep the file path as
a valid fallback.

#### Scenario: Interim path is concrete

- **WHEN** a harness follows the interim guidance
- **THEN** the docs SHALL name `events.jsonl` under `<state-home>/runs/<run_id>/`
- **AND** SHALL describe how `<state-home>` is resolved

#### Scenario: Monitoring is never forbidden for drive/resume

- **WHEN** drive or resume orchestration guidance is read
- **THEN** it SHALL NOT instruct the harness to avoid Monitor, background process,
  or event following

---

### Requirement: A drift-guard SHALL fail if the seconds-only / no-Monitor loop guidance returns

The repository’s automated tests (or an install/build check covered by `npm run ci`) SHALL fail if the shared fast-path packaging phrase claiming seconds-only completion and forbidding Monitor is reintroduced for the `loop` operation’s generated Claude command body.

#### Scenario: Forbidden phrase fails the guard

- **WHEN** `renderClaudeCommand` for the `loop` operation would emit “completes in
  seconds” or “No background process or Monitor needed”
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: True-fast commands remain allowed to use the fast template

- **WHEN** a non-loop operation such as `status` or `doctor` is rendered with the
  shared fast template
- **THEN** the loop drift-guard SHALL NOT fail solely because those operations
  still use seconds-only guidance
