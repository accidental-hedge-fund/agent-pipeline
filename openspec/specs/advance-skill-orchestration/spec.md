# advance-skill-orchestration Specification

## Purpose
TBD - created by archiving change advance-follow-reattach-until-terminal. Update Purpose after archive.
## Requirements
### Requirement: Single-issue advance host packaging SHALL specify detach, follow, re-attach, stop, and summarize

Host skill guidance for default-mode single-issue advance (`/pipeline N` and equivalent host invocations that start the advance loop) on Claude and Codex SHALL specify an ordered harness orchestration protocol that includes at least:

1. Status pre-check (synchronous).
2. Launch via detached run-store mode and capture the run-store `run_id`.
3. Follow the advance event stream (`pipeline logs <run-id> --events --follow`
   or equivalent on the run-store `events.jsonl`).
4. On material events, notify/push as already documented for §4.
5. On cancelled, interrupted, timed-out, or lost follow **before** terminal,
   re-attach per the re-attach requirement (same turn).
6. Stop following only on `run_complete` / sentinel completion (or confirmed
   already-terminal liveness), then emit the final summary and stop follows
   in the same turn.

#### Scenario: Ordered advance orchestration steps are present

- **WHEN** an operator reads the default advance orchestration section of
  `hosts/claude/SKILL.md` or `hosts/codex/SKILL.md`
- **THEN** the text SHALL list status pre-check, detached launch with run-store
  id, event follow, re-attach after lost wait, stop on `run_complete`/sentinel,
  and final summary as ordered obligations
- **AND** SHALL NOT instruct the host to treat default advance as fire-and-forget
  after detach without follow-to-terminal

---

### Requirement: Host advance orchestration SHALL re-attach after cancelled or lost follow before terminal

Host skill guidance (Claude and Codex) SHALL require that when a host follow/wait for a detached single-issue advance is cancelled, interrupted, times out without successful re-arm, or the host session otherwise loses the wait **before** a `run_complete` event or sentinel completion for that run, the harness acts **in the same harness turn** as follows:

1. Check run liveness or terminal state using run-store artifacts and/or
   `pipeline status <N>` (sentinel, `run_complete` in events, summary
   finalization, and/or process liveness when available).
2. If the run is already terminal, emit the final summary from
   `pipeline summary <run-id>` (or equivalent) and stop any remaining follows
   for that run — do not leave the operator without a terminal handoff.
3. If the run is still live or not confirmed terminal, re-arm
   `pipeline logs <run-id> --events --follow` (or an equivalent follow of the
   same run-store `events.jsonl`).
4. Continue until `run_complete` / sentinel completion, then emit the final
   summary and stop follows.

#### Scenario: Cancelled event wait re-arms follow in the same turn

- **WHEN** a harness following a detached advance has its events follow/wait
  cancelled or interrupted before `run_complete` / sentinel completion
- **AND** the detached run is still live
- **THEN** host skill guidance SHALL instruct the harness, in the same turn, to
  check liveness and re-arm events follow for the same run-store `run_id`
- **AND** SHALL instruct continue-until-terminal before final summary

#### Scenario: Lost wait after run already finished still requires terminal summary

- **WHEN** a harness loses the follow after the engine has already written
  `run_complete` or sentinel completion
- **THEN** host skill guidance SHALL instruct the harness to detect terminal
  state and emit the final summary (including `pipeline summary <run-id>`)
  without treating the lost wait as the end of the operator handoff

#### Scenario: Re-attach uses run-store id not informal tmp logs

- **WHEN** host skill guidance describes re-arm or recovery follow
- **THEN** it SHALL use `pipeline logs <run-id> --events --follow` (or the
  run-store `events.jsonl` path) with the real run-store id
- **AND** SHALL NOT present informal `/tmp/pipeline-*.log` scratch files as the
  evidence or follow contract

---

### Requirement: Host advance orchestration SHALL treat cancelled wait as non-terminal

Host skill guidance for single-issue advance SHALL state that a cancelled, interrupted, or timed-out follow/wait is **not** a terminal pipeline outcome and SHALL NOT instruct harnesses to stop supervising solely because the wait tool ended. Supervision ends only after confirmed `run_complete` / sentinel completion (or an explicit operator decision to abandon watching a still-live run, which is outside the default happy path).

#### Scenario: Cancelled wait is not stop-watching

- **WHEN** an operator or harness reads the advance orchestration recovery text
- **THEN** the text SHALL state that a cancelled wait is not a terminal pipeline
  outcome
- **AND** SHALL NOT equate Monitor/tool cancel with run completion

#### Scenario: Default path forbids silent stop after interrupt

- **WHEN** a follow is interrupted before terminal
- **THEN** host skill guidance SHALL NOT authorize ending the orchestration
  without liveness check and either re-attach or confirmed-terminal summary

---

### Requirement: Installable surfaces SHALL document a one-line operator re-attach path

Installable host skill (and any mirrored command packaging that restates advance recovery) SHALL document an operator/host re-attach path that uses run-store identifiers:

1. `pipeline status <N>` (or host equivalent) to discover stage/blocker/PR and
   help locate the active run when needed,
2. `pipeline logs <run-id> --events --follow` to resume event follow,
3. `pipeline summary <run-id>` after terminal to surface the evidence bundle.

The path SHALL name real run-store ids (from detach handoff / `run-store.json` /
run directory), not informal `/tmp` log paths.

#### Scenario: Re-attach path is concrete and copyable

- **WHEN** an operator whose host session lost the advance follow reads the
  re-attach documentation
- **THEN** the docs SHALL include the status + logs follow + summary commands
  with `<N>` / `<run-id>` placeholders
- **AND** SHALL NOT require reading ad-hoc session lessons to recover handoff

---

### Requirement: Final advance summary SHALL remain mandatory after terminal follow

Host skill guidance SHALL require that after a detached single-issue advance reaches `run_complete` / sentinel completion (including after one or more re-attach cycles), the harness emits a final operator summary that includes at least starting stage → ending stage, wall-clock or transitions when available, PR URL when a PR was opened, terminal state, and the merge-next-step note that the pipeline does not auto-merge. The harness SHALL stop run-scoped follows for that `run_id` in the same turn as the terminal summary.

#### Scenario: Terminal handoff includes summary and stop follows

- **WHEN** a harness observes `run_complete` or sentinel completion for the
  followed advance run
- **THEN** host skill guidance SHALL require a final summary including terminal
  state and PR when present
- **AND** SHALL require stopping that run’s follows in the same turn

---

### Requirement: A drift-guard SHALL fail if advance re-attach guidance is weakened

The repository’s automated tests (or an install/build check covered by `npm run ci`) SHALL fail if host skill single-issue advance orchestration guidance drops the requirements to (a) re-attach after cancelled/interrupted/lost follow before terminal, (b) treat cancelled wait as non-terminal, or (c) document the run-store re-attach path (`status` + `logs … --events --follow` + `summary`). The guard SHALL cover both `hosts/claude/SKILL.md` and `hosts/codex/SKILL.md` (or their generated install mirrors under the same source-of-truth discipline).

#### Scenario: Missing re-attach language fails the guard

- **WHEN** host skill §4 (or equivalent advance orchestration section) no longer
  requires re-attach after a cancelled or interrupted follow before terminal
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: Missing cancelled-wait-is-not-terminal language fails the guard

- **WHEN** host skill advance orchestration no longer states that a cancelled
  wait is not a terminal pipeline outcome
- **THEN** the drift-guard test or check SHALL fail

#### Scenario: Missing re-attach command path fails the guard

- **WHEN** host skill advance orchestration no longer documents a run-store
  re-attach path including events follow and summary by run id
- **THEN** the drift-guard test or check SHALL fail

### Requirement: Default advance orchestration SHALL consume outer-host lifecycle capabilities without host-name branching

Default single-issue advance host packaging SHALL be expressed against the active outer host's
declared lifecycle capabilities from the outer-host contract. That packaging covers status
pre-check, detach/launch, event follow, material notify, reattach after cancelled wait, terminal
stop, final summary, and terminal cleanup. Shared advance orchestration text and helpers SHALL
NOT encode lifecycle dispatch as host-name equality checks against a closed built-in set.

Closed reattach-until-terminal and cancelled-wait-is-not-terminal behaviors SHALL remain required
for hosts that declare reattach/event_follow support (or portable fallbacks), and SHALL be covered
by host-agnostic regression fixtures rather than provider or host-name tables.

#### Scenario: Capability-driven advance steps apply to a non-built-in host

- **WHEN** a registered outer host declares event follow, reattach, terminal cleanup, and
  terminal summary (or portable fallbacks)
- **AND** default advance orchestration is selected for that host
- **THEN** the shared contract SHALL require follow-until-terminal, reattach after cancelled wait,
  cleanup, and final summary using those declarations
- **AND** SHALL NOT require a new shared `if (host === "<id>")` branch to enable those steps

#### Scenario: Closed reattach behavior is a contract fixture not a host table

- **WHEN** regression coverage for cancelled-wait reattach runs
- **THEN** it SHALL assert the outer-host reattach/wait_cancel contract (capability-driven)
- **AND** SHALL NOT implement the requirement only as a table of built-in host names

