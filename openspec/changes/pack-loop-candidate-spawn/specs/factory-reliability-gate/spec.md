## ADDED Requirements

### Requirement: Bound pack-loop liveness SHALL require acknowledged process identity and a fresh heartbeat

After a valid `loop_run_handoff` for bound loop `L`, ship-path Factory Reliability Gate (FRG) pack composers SHALL treat `L` as live only when the exact PID, process-start identity, and boot identity in `supervisor.json` still match that acknowledgement and the supervisor heartbeat for `L` is fresh under the engine stale threshold. A non-terminal ledger, the absence of `ledger.stop`, and the absence of terminal events SHALL NOT prove live. A dead-or-missing lock pid SHALL NOT classify as live. False live SHALL NOT disable the wait cap. Unreadable identity evidence SHALL consume the normal bounded observation window and then fail closed with a typed observer or identity error. Unreadable identity SHALL NOT authorize resume and SHALL NOT count as live after that window. The next identical dead-pack stall SHALL not require a new mole issue.

#### Scenario: Dead pid plus open ledger is not live

- **WHEN** lock pid for bound loop `L` is dead or missing
- **AND** a ledger for `L` is present without `stop`
- **AND** events for `L` are not terminal
- **THEN** liveness SHALL NOT be `live`
- **AND** the wait cap SHALL remain applicable

#### Scenario: Never-dispatched non-terminal ledger is not live

- **WHEN** bound loop `L` has never produced a valid `loop_run_handoff`
- **AND** a non-terminal ledger for `L` exists
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Stale heartbeat is not live

- **WHEN** `supervisor.json` for bound loop `L` names a pid
- **AND** that pid is alive
- **AND** the heartbeat is older than the engine stale threshold
- **THEN** liveness SHALL NOT be `live`

#### Scenario: PID reuse is not live

- **WHEN** a later process reuses the numeric pid recorded for bound loop `L`
- **AND** process-start identity or boot identity does not match the acknowledged `supervisor.json` record
- **THEN** liveness SHALL NOT be `live`

#### Scenario: Unreadable identity fails closed after the observation window

- **WHEN** lock or `supervisor.json` identity evidence for bound loop `L` is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** liveness SHALL NOT remain unknown-as-live
- **AND** the composer SHALL fail closed with a typed observer or identity error
- **AND** it SHALL NOT authorize resume from that unreadable evidence

### Requirement: Pack-loop spawn SHALL surface bounded child stderr in ship last_error

Pack-loop spawn SHALL NOT ignore the child's stderr. A non-zero child exit SHALL capture bounded, redacted stderr in pipeline-owned evidence. Ship `last_error` SHALL include the exit status, a safe excerpt, and the evidence location. Catalogue validation text (or equivalent stderr) SHALL be visible in that diagnostic.

#### Scenario: Crash is visible and not false-live

- **WHEN** the pack child exits 1 before `ledger.stop`
- **AND** ship classifies liveness
- **THEN** the result SHALL NOT be `live`
- **AND** `last_error` SHALL contain the catalogue message or equivalent stderr
- **AND** `last_error` SHALL name the evidence location

#### Scenario: Stderr is not ignored

- **WHEN** pack-loop spawn launches the child
- **THEN** the child's stderr SHALL NOT be `stdio: "ignore"`
- **AND** a later non-zero exit SHALL still have a bounded redacted excerpt in pipeline-owned evidence

### Requirement: Pack-loop dispatch tests SHALL bite mixed-binary spawn and false-live

The test suite SHALL fail if candidate prepare writes `publish_unpublished_stage_commit` into the contract and the spawned loop binary is the pin catalogue that rejects that recipe. The suite SHALL fail if dead pid plus no `ledger.stop` plus no terminal events classifies as `live`. Coverage SHALL include candidate-versus-pin execution, pre-handoff failure, the spawn-before-handoff crash window, PID reuse, periodic heartbeat freshness during long work, one-resume enforcement, unreadable authority evidence, diagnostic propagation, and false-live rejection. Tests SHALL inject I/O through dependency seams and SHALL perform no real network, git, or subprocess calls.

#### Scenario: Mixed-binary spawn regression bites

- **WHEN** a unit test supplies candidate SHA `C` whose catalogue includes `publish_unpublished_stage_commit`
- **AND** PATH `pipeline` is pin `P` whose catalogue rejects that recipe
- **AND** `PIPELINE_BIN` is unset
- **THEN** the test SHALL fail if spawn execs pin `P`
- **AND** it SHALL pass when spawn execs the candidate launcher for `C`

#### Scenario: False-live regression bites

- **WHEN** a unit test supplies a dead-or-missing lock pid
- **AND** a present ledger with no `stop`
- **AND** non-terminal events
- **THEN** the test SHALL fail if liveness is `live`

## MODIFIED Requirements

### Requirement: Durable post-pilot FRG generation SHALL start or resume a request-bound pack loop

For every release version after v1.33.0, the durable FRG generator SHALL start
or resume one `factory-gate` pack loop bound to the active prepare request.
When no request-bound loop exists, the generator SHALL create or reuse pack
issues from the checked-in `factory-gate-v1` templates so the item count meets
the pack manifest minimum, allocate the candidate-track run id, persist
`factory-release-binding.json` on that loop (request fingerprint, candidate
git SHA, target version, pack/manifest identity) together with a non-null
`loop_run_id` on the pack instance, and only then spawn or resume the loop.
Spawn SHALL exec the verified candidate launcher that wrote the contract
(absolute executable, argv, and candidate SHA). PATH `pipeline` and
`PIPELINE_BIN` SHALL NOT be production fallbacks. `--engine-track candidate`
SHALL remain intent metadata and SHALL NOT select the binary. The generator
SHALL persist binding `dispatch_state` `bound` before spawn. It SHALL persist
`dispatched` only after a valid `loop_run_handoff` for that `loop_run_id` with
absolute artifact paths and matching `supervisor.json` process identity.
A failed OS spawn (child never started) SHALL fail that tick and SHALL leave
the request bound to the same `loop_run_id` so a later invoke can retry spawn.
A child that exits non-zero before the first valid handoff SHALL fail that
tick closed and SHALL NOT be retried as a second blind spawn. While that
bound loop is not terminal, the generator SHALL return a machine-readable
in-progress status and SHALL NOT treat the missing terminal loop as
`missing_generator` or `pack_loop_missing`. A re-invoke of the same request
SHALL resume the same `loop_run_id` and SHALL NOT start a second unbound pack.
Before spawning, the generator SHALL reconcile a persisted `bound` state:
adopt a valid existing holder, observe an in-window startup, and fail closed
on a proven pre-handoff failure. It SHALL NOT blindly create a second child.
The generator SHALL NOT adopt an unbound newest `factory-gate` loop as the
bound run or as release-eligible evidence.

#### Scenario: First prepare with no bound loop dispatches a candidate pack loop

- **WHEN** durable FRG generation runs for a post-1.33 version
- **AND** no `factory-release-binding.json` matches the request fingerprint,
  candidate SHA, version, and manifest
- **THEN** the generator SHALL create or reuse pack issues from
  `factory-gate-v1` templates that meet the manifest minimum item count
- **AND** it SHALL persist a non-null `loop_run_id` on the pack instance
  together with a matching `factory-release-binding.json` before spawn
- **AND** it SHALL then dispatch one durable loop on the candidate engine
  launcher for that SHA with the pack work-list or the `factory-gate` label
- **AND** it SHALL return in-progress status without inventing `pass: true`

#### Scenario: Second prepare resumes the same bound loop

- **WHEN** a later invoke uses the same prepare request
- **AND** the pack instance already records `loop_run_id` `L` with a matching
  binding
- **THEN** the generator SHALL resume `L`
- **AND** it SHALL NOT start another pack loop

#### Scenario: Unbound newest factory-gate loop is not adopted

- **WHEN** an unbound newest `factory-gate` loop exists
- **AND** no `factory-release-binding.json` matches the active request
- **THEN** the generator SHALL NOT adopt that unbound loop as the bound run
- **AND** it SHALL start or resume only a request-bound pack loop

#### Scenario: Crash after persist before spawn resumes the same bound run

- **WHEN** the generator has persisted pack-instance `loop_run_id` `L` and a
  matching `factory-release-binding.json`
- **AND** the process stops before spawn confirms
- **THEN** a later invoke of the same request SHALL resume `L`
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Failed detached spawn is retried on the same bound run

- **WHEN** detached spawn fails at startup before the child starts (including ENOENT)
- **THEN** that tick SHALL NOT return in-progress as if the loop were running
- **AND** `dispatch_state` SHALL remain `bound`
- **AND** a later invoke of the same request SHALL retry spawn of the same
  `loop_run_id`
- **AND** it SHALL NOT start a second unbound pack

#### Scenario: Pre-handoff child exit is not retried

- **WHEN** the OS accepted the child
- **AND** the child exits non-zero before a valid `loop_run_handoff`
- **THEN** that tick SHALL fail closed
- **AND** it SHALL NOT persist `dispatch_state` `dispatched`
- **AND** a later invoke SHALL NOT blindly spawn a second child

#### Scenario: OS accept does not mark dispatched

- **WHEN** the OS reports spawn success for the pack child
- **AND** no valid `loop_run_handoff` has been observed
- **THEN** `dispatch_state` SHALL remain `bound`

### Requirement: Ship-path FRG pack composers SHALL wait until the bound pack loop is terminal

A ship-path Factory Reliability Gate (FRG) pack composer (Tugboat, the installed `pipeline-ship-playbook` launcher, in-engine `pipeline ship`, or any later composer of the same durable prepare protocol) SHALL keep re-invoking the same `factory-release prepare` request while prepare status is `in_progress` and the bound pack loop is live. Live SHALL mean acknowledged-process liveness: a valid `loop_run_handoff` for that exact loop, plus the exact PID, process-start identity, boot identity, and a fresh heartbeat. A non-terminal ledger SHALL NOT prove live. Wait-budget expiry while that loop is live SHALL NOT be pack-fail. The composer SHALL heartbeat running ship state on each wait tick. The composer SHALL NOT kill the pack loop. The composer SHALL NOT treat a CI-length poll cap (about 20 minutes) as the live-loop stop. Wait-budget expiry MAY be pack-fail when the bound loop is not live. Unreadable identity evidence SHALL consume the bounded observation window and then fail closed with a typed observer or identity error. It SHALL NOT keep wait-budget from applying as not-live after that window. Real pack-fail (failed or missing FRG that is not omitted-HMAC-only, `latest.json` `pass: false` after a terminal **ineligible** score, attestor child failure) SHALL still fail closed. `latest.json` `pass: false` caused only by omitted HMAC on a structurally eligible pack SHALL NOT be pack-fail. The next identical 20-minute live-loop wait SHALL not require a new mole issue. The next identical dead-pack stall SHALL not require a new mole issue.

This requirement does not raise the implementer 2400s cap. It does not authorize `--skip-frg` as the ship path. It does not change CI / release-PR check wait.

#### Scenario: Live bound loop outlives a short wait cap

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is live under acknowledged-process liveness
- **AND** a numeric wait cap equal to a CI poll (about 20 minutes) expires
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep re-invoking the same request
- **AND** it SHALL NOT kill loop `L`

#### Scenario: Dead bound loop may still fail on wait budget

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** `L` is not live
- **AND** the not-live wait budget is exhausted
- **THEN** the composer MAY fail the pack phase
- **AND** it SHALL NOT invoke `pipeline release` for that version on that evidence

#### Scenario: Dead pid plus open ledger does not disable the wait cap

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** lock pid for `L` is dead or missing
- **AND** the ledger for `L` is present without `stop`
- **AND** events for `L` are not terminal
- **THEN** the composer SHALL NOT classify `L` as live
- **AND** wait-budget expiry MAY be pack-fail

#### Scenario: Unreadable liveness state is not pack-fail

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has not expired
- **THEN** the composer SHALL NOT declare pack-fail for wait-budget exhaustion
- **AND** it SHALL keep observing `L`

#### Scenario: Unreadable identity after the observation window is pack-fail

- **WHEN** a ship-path composer sees prepare `status: "in_progress"` for bound loop `L`
- **AND** identity evidence for `L` is unreadable or malformed
- **AND** the bounded observation window has expired
- **THEN** the composer SHALL fail closed with a typed observer or identity error
- **AND** it SHALL NOT keep re-invoking as if `L` were live

#### Scenario: Next identical 20-minute live pack needs no new mole

- **WHEN** a later 2-item factory-gate pack is still `in_progress` after 20 minutes
- **AND** the bound loop is live under acknowledged-process liveness
- **THEN** the same composer wait law SHALL keep ticking prepare
- **AND** the ship SHALL NOT require a human re-detach or a new mole issue to finish the pack
