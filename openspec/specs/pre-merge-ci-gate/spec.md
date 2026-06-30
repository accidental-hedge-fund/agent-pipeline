# pre-merge-ci-gate Specification

## Purpose
TBD - created by archiving change pre-merge-gate-convergence. Update Purpose after archive.
## Requirements
### Requirement: CI failure with rebase guard exhausted blocks to needs-human

When CI check runs are definitively failing (not pending) and the per-worktree rebase marker has already been set (rebase guard exhausted), the pre-merge gate SHALL call `setBlocked` with the `needs-human` label and a reason that names each failing check, then return `blocked`. It SHALL NOT return `waiting`.

#### Scenario: CI failing, rebase already attempted — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** the per-worktree rebase marker (`rebaseAlreadyAttempted`) is set
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }`
- **AND** SHALL NOT return `waiting` or attempt another rebase

#### Scenario: CI failing, rebase attempt fails — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false (first attempt)
- **AND** `tryRebaseAndPush` returns false (rebase or push could not complete)
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }`

#### Scenario: CI failing, first rebase succeeds — wait for CI to re-run

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false (first attempt)
- **AND** `tryRebaseAndPush` returns true
- **THEN** the gate SHALL mark the rebase as attempted
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`

### Requirement: Block reason names the failing checks

When the pre-merge gate blocks due to CI failure, the block reason SHALL include the name and bucket of each failing check run so the operator can identify which check to fix without querying GitHub manually.

#### Scenario: failing check names are surfaced in the block comment

- **WHEN** the gate calls `setBlocked` due to a CI failure
- **THEN** the reason text SHALL contain the name and status of each check in `agg.failed`
- **AND** SHALL NOT use only a generic message without check details

### Requirement: The CI gate SHALL detect a zero-check-run head SHA and enter recovery after the grace window

The CI gate SHALL query `GET /repos/{repo}/commits/{sha}/check-runs` to obtain the
actual check-run count for the head SHA when pending checks are observed and at least
`ci_no_run_grace_s` seconds have elapsed since CI-gate entry. If the count is zero,
the gate SHALL enter the no-run recovery path rather than returning `waiting` as if
runs were simply pending.

#### Scenario: grace window elapsed, zero check-runs — recovery path entered

- **WHEN** `getPrChecks` returns pending checks for the head SHA
- **AND** at least `ci_no_run_grace_s` seconds have elapsed since the CI-gate path was entered
- **AND** `getHeadCheckRunCount(headSha)` returns 0
- **THEN** the gate SHALL NOT return `{ status: "waiting", reason: "CI still running" }` as if runs were pending
- **AND** SHALL evaluate the archive-only and prior-SHA-green conditions to choose between auto-recovery and actionable error

#### Scenario: grace window not yet elapsed — normal pending behavior preserved

- **WHEN** `getPrChecks` returns pending checks for the head SHA
- **AND** the elapsed time since CI-gate entry is less than `ci_no_run_grace_s` seconds
- **THEN** the gate SHALL return `{ advanced: false, status: "waiting", reason: "CI still running" }` without querying the check-runs API

#### Scenario: check-run count is positive — zero-run path skipped

- **WHEN** `getPrChecks` returns pending checks
- **AND** the grace window has elapsed
- **AND** `getHeadCheckRunCount(headSha)` returns a positive integer
- **THEN** the gate SHALL return `{ advanced: false, status: "waiting", reason: "CI still running" }` unchanged (runs exist, just pending)

---

### Requirement: The gate SHALL auto-recover via close+reopen when the no-run case is archive-only and the prior SHA was green

The gate SHALL automatically close and reopen the PR to re-fire the `pull_request`
event when zero check-runs are detected for the head SHA AND the diff between the
pre-archive SHA and the head SHA touches only paths under `openspec/` AND the
pre-archive SHA had at least one successful check-run. After close+reopen the gate
SHALL return `waiting` to resume polling on the next pipeline tick.

#### Scenario: archive-only diff + prior SHA green → close+reopen then wait

- **WHEN** zero check-runs are detected for the head SHA
- **AND** the pre-archive SHA has at least one check-run with `conclusion=success`
- **AND** the diff `preArchiveSha..headSha` contains only paths under `openspec/`
- **THEN** the gate SHALL call `closePr(cfg, prNumber)` then `reopenPr(cfg, prNumber)`
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "no CI run detected; closed and reopened PR to re-fire CI" }`
- **AND** SHALL NOT call `setBlocked`

#### Scenario: archive-only diff but prior SHA has only failed check-runs — block with actionable message

- **WHEN** zero check-runs are detected for the head SHA
- **AND** the diff contains only paths under `openspec/`
- **AND** the pre-archive SHA has zero check-runs with `conclusion=success` (e.g. all failed or cancelled)
- **THEN** the gate SHALL NOT call `closePr` or `reopenPr`
- **AND** SHALL call `setBlocked` with label `needs-human` and a reason of the form "no CI run detected for head SHA <sha>; try closing and reopening the PR to re-fire GitHub Actions"
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "..." }`

#### Scenario: archive-only condition met but close+reopen fails — block with needs-human

- **WHEN** zero check-runs are detected and the archive-only condition is met
- **AND** `closePr` or `reopenPr` throws an error
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason that includes the failure detail
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "..." }`

#### Scenario: second zero-count poll for the same head SHA after recovery — no additional close+reopen

- **WHEN** zero check-runs are detected for a head SHA
- **AND** a close+reopen recovery was already attempted for that same head SHA in a prior poll
- **THEN** the gate SHALL NOT call `closePr` or `reopenPr` again
- **AND** SHALL call `setBlocked` with label `needs-human` and a reason indicating that recovery was already attempted
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "..." }`

---

### Requirement: The gate SHALL surface an actionable error when zero check-runs exist for a non-archive-only diff

The gate SHALL call `setBlocked` with label `needs-human` and an actionable message
when zero check-runs are detected for the head SHA AND the diff is not limited to
`openspec/` paths (or the pre-archive SHA is unavailable), rather than waiting out
`ci_timeout`.

#### Scenario: zero check-runs, non-archive diff — block with actionable message

- **WHEN** zero check-runs are detected for the head SHA
- **AND** the diff touches files outside `openspec/`, OR the pre-archive SHA is unavailable
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason of the form "no CI run detected for head SHA <sha>; try closing and reopening the PR to re-fire GitHub Actions"
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "..." }`
- **AND** SHALL NOT call `closePr` or `reopenPr`
- **AND** SHALL NOT wait out `ci_timeout`

---

### Requirement: `ci_no_run_grace_s` SHALL be a configurable key with a default of 60

The pipeline configuration SHALL accept a `ci_no_run_grace_s` key (non-negative
integer, seconds) controlling how long the gate waits before checking for zero
check-runs. The default value SHALL be 60. Setting it to 0 disables the grace window.

#### Scenario: default grace window applies when key is absent

- **WHEN** `pipeline.json` does not include `ci_no_run_grace_s`
- **THEN** `cfg.ci_no_run_grace_s` SHALL equal 60

#### Scenario: operator sets custom grace window

- **WHEN** `pipeline.json` contains `"ci_no_run_grace_s": 120`
- **THEN** `cfg.ci_no_run_grace_s` SHALL equal 120
- **AND** the gate SHALL not query check-run count until 120 s have elapsed

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

The gate SHALL be SHA-aware: the test-gate harness SHALL record the worktree HEAD SHA at test time as `pr_head_sha` in the `stage_accounting` event it writes to the run store. The pre-merge gate SHALL read this `pr_head_sha` from the event and compare it to the current PR head. When they differ — regardless of the reason (developer push while review was running, OpenSpec archive commit, BEHIND/conflict rebase, or any other cause) — the gate SHALL block with `needs-human` and SHALL NOT treat the earlier passing result as certification of the current head. The user SHALL re-run the pipeline to obtain a fresh test-gate result against the current head. When `pr_head_sha` is absent from the event (legacy event without the field), the gate SHALL also fail closed and block.

#### Scenario: recorded local test-gate pass advances to mergeability

- **WHEN** `cfg.ci_mode` is `"local"` and the current run's most-recent test-gate outcome is a pass
- **AND** the `pr_head_sha` recorded in the test-gate event matches the current PR head
- **THEN** the gate SHALL proceed to the mergeability step without calling `getPrChecks`
- **AND** SHALL NOT block on the CI step

#### Scenario: local mode blocks when PR head moved after test gate ran

- **WHEN** `cfg.ci_mode` is `"local"`, the most-recent test-gate outcome is a pass, but the `pr_head_sha` in the event does not match the current PR head (e.g. a developer push while review ran, an OpenSpec archive commit, or a conflict/BEHIND rebase)
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` and a reason naming the stale test-gate result and the pre-mutation head
- **AND** SHALL return `{ advanced: false, status: "blocked" }`
- **AND** SHALL NOT advance to the mergeability step

#### Scenario: local mode blocks when pr_head_sha absent in event (legacy format)

- **WHEN** `cfg.ci_mode` is `"local"`, the most-recent test-gate outcome is a pass, but the event carries no `pr_head_sha` field
- **THEN** the gate SHALL call `setBlocked` with label `needs-human` (fail-closed)
- **AND** SHALL return `{ advanced: false, status: "blocked" }`

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

