## ADDED Requirements

### Requirement: Train advance STOP and item errors SHALL quote structured loop stop evidence before raw exit code

When a train advance wave (or a legacy single-item advance adapter used only where that path still exists) ends with a non-ok outcome or causes train to record a STOP / hold `error` / `train_status.blocker` string attributable to that advance attempt, the pipeline SHALL compose the human-visible reason from structured loop evidence for that attempt when present, in this priority order:

1. the last `loop_run_stopped.reason` value for the attempt’s loop run (for example `supervisor_no_progress`, `dependency_deadlock`, `recovery_exhausted` when emitted as that reason);
2. the last `loop_item_blocked.class` value plus the blocked issue identity;
3. the last blocker comment first line and/or `blocker_kind` when available from that attempt’s blocker evidence;
4. only then the raw process exit code (or engine failure message).

The composed string SHALL include the relevant issue number when the failure is attributable to a specific work-list issue. When any of (1)–(3) are present, the human-visible train STOP reason, per-item `error`, and `train_status.blocker` SHALL NOT consist solely of an exit-only phrase such as `pipeline single exited with code 1` or `pipeline advance exited with code 1`. When no structured loop evidence is available for the attempt, the pipeline SHALL still include the exit code or engine failure message and SHALL NOT invent a stop class or block class name. Non-zero train exit and incomplete status semantics SHALL remain non-zero / incomplete on failure; this requirement changes only the diagnostic text, not success masking. Production train SHALL continue to use multi-item loop advance waves for frontiers and SHALL NOT switch to N×`single` solely to attach this message.

#### Scenario: supervisor_no_progress appears in train blocker

- **WHEN** a train advance wave ends non-ok for issue N
- **AND** the attempt’s loop events include a last `loop_run_stopped` whose reason is `supervisor_no_progress`
- **THEN** the train’s human-visible STOP reason or `train_status.blocker` (and the matching per-item `error` when the failure is attributed to that item) SHALL contain `supervisor_no_progress`
- **AND** SHALL contain the issue number N
- **AND** SHALL NOT be only an exit-only phrase such as `pipeline advance exited with code 1` or `pipeline single exited with code 1`

#### Scenario: loop_item_blocked class is quoted with issue

- **WHEN** a train advance attempt records a last `loop_item_blocked` event with class `recovery_exhausted` for issue N
- **AND** that evidence is used under the priority order (for example no higher-priority stop reason, or the composed string still includes the class)
- **THEN** the human-visible train item error or STOP / blocker text SHALL contain `recovery_exhausted`
- **AND** SHALL identify issue N

#### Scenario: exit code only when no loop evidence

- **WHEN** a train advance attempt exits non-zero
- **AND** no loop events and no structured block/stop evidence are available for that attempt
- **THEN** the human-visible train error / blocker SHALL include the exit code or engine failure message
- **AND** it SHALL NOT invent a stop class name such as `supervisor_no_progress` or `dependency_deadlock`

#### Scenario: failure remains non-zero

- **WHEN** a train advance attempt fails under any of the scenarios above
- **THEN** the train process SHALL still exit non-zero or report incomplete status with a blocker
- **AND** it SHALL NOT treat the attempt as successful solely because structured diagnostic text was attached

#### Scenario: enrichment is regression-tested with injected deps

- **WHEN** the automated train tests for this requirement run under `npm run ci`
- **THEN** at least one fixture SHALL fail if `supervisor_no_progress` (or equivalent stop reason under test) is present in injected loop evidence but absent from the train blocker / item error
- **AND** at least one fixture SHALL pass with exit-code-only text when evidence is empty without inventing a class
- **AND** the tests SHALL inject deps (no real network, git, or subprocess for this logic)
