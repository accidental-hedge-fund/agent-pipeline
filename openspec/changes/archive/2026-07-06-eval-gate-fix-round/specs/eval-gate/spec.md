## MODIFIED Requirements

### Requirement: gate mode blocks on fail; advisory mode never blocks

The `eval_gate.mode` config key SHALL control blocking behavior. In `gate` mode (default) the stage
SHALL, on an ordinary non-zero exit (not a timeout, not a spawn/runner error), first route the
failure through the `eval-gate-fix-round` loop when fix attempts remain; it SHALL call `setBlocked`
and SHALL NOT advance only after the `eval_gate.max_attempts` budget is exhausted (or immediately
when `eval_gate.max_attempts` is `1`). When an eval pass follows an eval-fix commit that has not yet
cleared pre-merge review — determined durably from GitHub PR state rather than from any single
invocation's in-memory history, so it also catches a fix commit pushed in an earlier, interrupted
invocation — the stage SHALL transition to `pre-merge` instead of advancing directly (see the
`eval-gate-fix-round` capability's review-gate requirement). In `advisory` mode the stage SHALL
record the result comment and SHALL transition to the next stage (`shipcheck-gate` when opted in,
else `ready-to-deploy`) regardless of exit code, and SHALL NOT route to a fix round.

#### Scenario: gate mode + pass with no unreviewed eval-fix commit — advances to the next stage

- **WHEN** mode is `"gate"` (or absent/default)
- **AND** the eval command exits 0
- **AND** no eval-fix commit has landed on the PR since the last reviewed SHA
- **THEN** the stage SHALL transition to the configured next stage (`shipcheck-gate` when opted in,
  else `ready-to-deploy`)

#### Scenario: gate mode + fail with budget remaining — routes to a fix round

- **WHEN** mode is `"gate"` (or absent/default)
- **AND** the eval command exits non-zero (not a timeout, not a spawn error)
- **AND** at least one eval attempt remains under `eval_gate.max_attempts`
- **THEN** the stage SHALL invoke the implementer harness (see the `eval-gate-fix-round` capability)
- **AND** SHALL NOT call `setBlocked` on this failure

#### Scenario: gate mode + fail with budget exhausted — blocks

- **WHEN** mode is `"gate"` (or absent/default)
- **AND** the eval command exits non-zero after `eval_gate.max_attempts` is exhausted
- **THEN** the stage SHALL call `setBlocked` on the issue with the final eval output
- **AND** SHALL NOT transition to the next stage

#### Scenario: advisory mode + fail — records result and advances

- **WHEN** mode is `"advisory"`
- **AND** the eval command exits non-zero
- **THEN** the stage SHALL post the eval result comment
- **AND** SHALL transition to the next stage
- **AND** SHALL NOT invoke the implementer harness
- **AND** SHALL NOT call `setBlocked`

#### Scenario: advisory mode + pass — advances normally

- **WHEN** mode is `"advisory"`
- **AND** the eval command exits 0
- **THEN** the stage SHALL post the eval result comment
- **AND** SHALL transition to the next stage

---

### Requirement: step is time-bounded with transient-error retry

The eval stage SHALL enforce a hard timeout of `eval_gate.timeout` seconds (default 300) on each eval
command run. If a run exceeds the timeout, it is killed and counts as a tooling failure. The stage
SHALL run the eval command up to `eval_gate.max_attempts` times (default 2). In `gate` mode each run
after the first SHALL be preceded by exactly one fix round (see the `eval-gate-fix-round` capability),
so a retry re-runs the eval against fixed code rather than re-running the identical command. A
timeout or a spawn/runner error SHALL be treated as a tooling failure that blocks immediately with an
"eval-gate timed out or errored" message regardless of mode, and SHALL NOT trigger a fix round or a
further retry. After the `gate`-mode fix-round budget is exhausted with the eval still failing, the
stage SHALL call `setBlocked`.

#### Scenario: timeout kills the command and is a tooling failure

- **WHEN** the eval command runs longer than `eval_gate.timeout` seconds
- **THEN** the child process SHALL be terminated
- **AND** the result SHALL be treated as a tooling failure that blocks immediately (kind
  `harness-failure`) regardless of mode
- **AND** SHALL NOT trigger a fix round

#### Scenario: gate-mode retry re-runs against fixed code

- **WHEN** the first eval attempt exits non-zero in `gate` mode
- **AND** `max_attempts` is 2
- **THEN** the stage SHALL run one fix round before the second attempt
- **AND** the second attempt SHALL run the eval command against the fixed, pushed code
- **AND** if the second attempt exits 0 the stage SHALL produce a pass outcome

#### Scenario: gate-mode fix budget exhausted — blocks

- **WHEN** every `max_attempts` gate-mode eval run fails after its fix round
- **THEN** the stage SHALL call `setBlocked` with the final eval output
- **AND** SHALL NOT transition to the next stage

#### Scenario: spawn/runner error blocks immediately regardless of mode

- **WHEN** the eval command cannot be executed (spawn/runner error)
- **THEN** the stage SHALL call `setBlocked` with kind `harness-failure`
- **AND** SHALL NOT trigger a fix round
- **AND** SHALL NOT re-run the eval command
