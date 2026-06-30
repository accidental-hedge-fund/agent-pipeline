## ADDED Requirements

### Requirement: The pre-merge CI gate's verification source SHALL be selected by `ci_mode`

The pre-merge CI gate SHALL consult `cfg.ci_mode` to decide how it verifies CI. When `ci_mode` is `"github"` (the default), the gate SHALL behave exactly as specified by every other requirement in this capability — polling `gh pr checks` via `getPrChecks`, running the zero-check-run recovery path, and rebasing on CI failure — and those requirements apply unchanged. When `ci_mode` is `"local"`, the gate SHALL NOT call `getPrChecks` (nor `getHeadCheckRunCount` / `getSuccessfulCheckRunCount` nor any other GitHub check-runs API) and SHALL instead verify the current run's recorded local test-gate outcome. Selecting `ci_mode` SHALL affect only this CI step: the early conflict pre-check, the post-CI mergeability gate, and the OpenSpec-validation gate SHALL run identically in both modes.

#### Scenario: github mode polls GitHub checks (default behavior preserved)

- **WHEN** `cfg.ci_mode` is `"github"` and the pre-merge gate reaches the CI step
- **THEN** the gate SHALL call `getPrChecks` and follow the existing GitHub-checks requirements (pending → waiting, failed → rebase-or-block, zero-run recovery)

#### Scenario: local mode does not call the GitHub checks API

- **WHEN** `cfg.ci_mode` is `"local"` and the pre-merge gate reaches the CI step
- **THEN** the gate SHALL NOT call `getPrChecks` or any GitHub check-runs API
- **AND** SHALL determine the CI result from the current run's recorded test-gate outcome instead

### Requirement: In `ci_mode: local` the gate SHALL advance only on the current run's most-recent passing test-gate outcome

When `cfg.ci_mode` is `"local"`, the pre-merge gate SHALL read the current run's test-gate outcome from the run store (the `runDir` event log) and SHALL treat a recorded passing test-gate result as the CI signal. When the most-recent recorded test-gate outcome for the current run is a pass, the gate SHALL proceed to the mergeability and OpenSpec-validation steps exactly as the `github` path proceeds after CI passes (it SHALL NOT return early). When the most-recent recorded test-gate outcome is a failure, the gate SHALL NOT advance and SHALL call `setBlocked` with the `needs-human` label and a reason naming the failed local test gate.

The gate SHALL be SHA-aware: when the pre-merge gate detects that the PR head has moved past the head at which the test gate ran (due to a pre-merge mutation such as an OpenSpec archive commit or a BEHIND/conflict rebase pushed in a prior iteration), it SHALL block with `needs-human` and SHALL NOT treat the earlier passing result as certification of the current head. The user SHALL re-run the pipeline to obtain a fresh test-gate result against the mutated head.

#### Scenario: recorded local test-gate pass advances to mergeability

- **WHEN** `cfg.ci_mode` is `"local"` and the current run's most-recent test-gate outcome is a pass
- **AND** the PR head has not moved since the test gate ran
- **THEN** the gate SHALL proceed to the mergeability step without calling `getPrChecks`
- **AND** SHALL NOT block on the CI step

#### Scenario: local mode blocks when PR head moved after test gate ran

- **WHEN** `cfg.ci_mode` is `"local"`, the most-recent test-gate outcome is a pass, but the PR head has moved since the test gate ran (e.g. an OpenSpec archive commit was pushed, or a conflict/BEHIND rebase was performed in a prior pre-merge iteration)
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason naming the stale test-gate result and the pre-mutation head
- **AND** SHALL return `{ advanced: false, status: "blocked" }`
- **AND** SHALL NOT advance to the mergeability step

#### Scenario: recorded local test-gate failure blocks

- **WHEN** `cfg.ci_mode` is `"local"` and the current run's most-recent test-gate outcome is a failure
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason naming the failed local test gate
- **AND** SHALL return `{ advanced: false, status: "blocked" }`

#### Scenario: mergeability and OpenSpec gates still run in local mode

- **WHEN** `cfg.ci_mode` is `"local"`, the local test gate passed, but the PR is conflicting (`mergeable === false`) or its OpenSpec change is structurally invalid
- **THEN** the gate SHALL still block on the respective downstream gate (conflict recovery or `openspec-invalid`)
- **AND** SHALL NOT advance to `ready-to-deploy` solely because the local test gate passed

### Requirement: In `ci_mode: local` the gate SHALL fail closed when no local test-gate result is present for the current run

When `cfg.ci_mode` is `"local"` and no recorded test-gate outcome is available for the current run — because the run directory is absent, the run produced no test-gate result (the test gate was disabled or auto-detected no command and was skipped), or the event log cannot be read — the pre-merge gate SHALL NOT advance. It SHALL call `setBlocked` with the `needs-human` label and a reason stating that `ci_mode: local` found no local test-gate result for this run, and SHALL return a blocked outcome. The gate SHALL NOT silently skip CI verification.

#### Scenario: run directory present but no test-gate result

- **WHEN** `cfg.ci_mode` is `"local"`, a run directory exists, but it records no `test-gate` outcome for the current run
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason stating that no local test-gate result was found for this run
- **AND** SHALL return `{ advanced: false, status: "blocked" }`
- **AND** SHALL NOT advance to the mergeability step

#### Scenario: no run directory available

- **WHEN** `cfg.ci_mode` is `"local"` and no run directory is available to read a test-gate outcome from
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and SHALL NOT advance

#### Scenario: never silently skip verification

- **WHEN** `cfg.ci_mode` is `"local"` and a local test-gate result is unavailable for any reason
- **THEN** the gate SHALL block rather than treating the absent result as a pass
