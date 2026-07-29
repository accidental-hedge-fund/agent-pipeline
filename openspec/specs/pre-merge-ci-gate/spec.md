# pre-merge-ci-gate Specification

## Purpose
TBD - created by archiving change pre-merge-gate-convergence. Update Purpose after archive.
## Requirements
### Requirement: CI failure with rebase guard exhausted blocks to needs-human

When CI check runs are definitively failing (not pending), the pre-merge gate SHALL first apply the bounded recovery ladder defined by the "bounded CI recovery budget" requirements in this capability. Only after that budget is exhausted for the current head SHA SHALL the gate call `setBlocked` and return `blocked`. When escalating, the gate SHALL use blocker kind `ci-exhausted` (not a bare generic `needs-human` without classification) and a reason that names each failing check. It SHALL NOT return unbounded `waiting` solely because checks are red, and SHALL NOT re-enter an archive/poll spin loop (#181 non-regression).

#### Scenario: CI failing, recovery budget exhausted — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** the per-head-SHA recovery budget for this head is exhausted (rebase policy applied as configured, re-run already attempted or inapplicable, archive-only recovery already attempted or inapplicable, assertion auto-fix already attempted or disabled/inapplicable)
- **THEN** the gate SHALL call `setBlocked` with kind `ci-exhausted` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }` (or an equivalent blocked reason that identifies CI exhaustion)
- **AND** SHALL NOT return `waiting` or attempt another automatic recovery for the same head SHA

#### Scenario: CI failing, first rebase succeeds — wait for CI to re-run

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false (first attempt)
- **AND** `tryRebaseAndPush` returns true
- **THEN** the gate SHALL mark the rebase as attempted
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: CI failing, rebase attempt fails — continue recovery ladder (not instant generic block)

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** `rebaseAlreadyAttempted` is false
- **AND** `tryRebaseAndPush` returns false (rebase or push could not complete)
- **THEN** the gate SHALL NOT treat rebase failure alone as the end of all recovery when further budget steps remain (classification / re-run / archive-aware recovery / optional assertion fix)
- **AND** when no further recovery step applies, SHALL escalate with `ci-exhausted` as in the budget-exhausted scenario

### Requirement: Block reason names the failing checks

When the pre-merge gate blocks due to CI failure budget exhaustion, the block reason SHALL include enough evidence for an operator to act without manually reconstructing the CI failure: the name and conclusion/bucket of each failing check, job or run URL(s) when available from check metadata, the head SHA, the pre-archive green SHA when archive-only prior-green evidence applies, the classification used (`infra`, `assertion`, or `unknown`), a short log excerpt when available, and exact next operator steps (including whether an automatic re-run was already attempted). The kind-specific `ci-exhausted` recipe (via `BLOCKER_RECIPES`) SHALL appear in the blocked comment's recovery section.

#### Scenario: failing check names are surfaced in the block comment

- **WHEN** the gate calls `setBlocked` due to CI budget exhaustion
- **THEN** the reason text SHALL contain the name and status of each check in `agg.failed`
- **AND** SHALL NOT use only a generic message without check details

#### Scenario: block comment includes URL, SHA, classification, and recipe evidence

- **WHEN** the gate calls `setBlocked` due to CI budget exhaustion
- **AND** failing checks expose `link` URLs and a classification was computed
- **THEN** the reason text SHALL include at least one job/run URL when available
- **AND** SHALL include the head SHA (full or unambiguous short form)
- **AND** SHALL include the classification label (`infra`, `assertion`, or `unknown`)
- **AND** SHALL include a short log excerpt when log fetch succeeds, or omit the excerpt without inventing content when fetch fails
- **AND** the blocked comment SHALL render the `ci-exhausted` recovery recipe under "### How to unblock"

#### Scenario: archive-only escalation surfaces pre-archive green evidence

- **WHEN** the gate escalates after a red head that was archive-only relative to `preArchiveSha`
- **AND** the pre-archive SHA had at least one successful check-run
- **THEN** the block reason SHALL name the pre-archive green SHA in addition to the current head SHA

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

### Requirement: The pre-merge CI gate SHALL classify definitive failures before recovery or escalate

When `getPrChecks` reports one or more definitive failures (not pending), the gate SHALL classify the failure set into exactly one of: `infra` (infrastructure or flake signatures), `assertion` (product/test/lint/type assertion failures), or `unknown` (cannot classify confidently). Classification SHALL be deterministic from check metadata and optional bounded log excerpts (no non-deterministic LLM required). When the failed set mixes assertion-class and infra-class signals, the overall classification SHALL be `assertion`. The chosen class SHALL be recorded in run evidence when a run directory is available and SHALL appear in any eventual CI-exhaustion block comment.

#### Scenario: infra signature classifies as infra

- **WHEN** definitive failures are present
- **AND** check metadata and/or log excerpt match a known infrastructure signature (e.g. test-runner IPC deserialize error, runner OOM, cancelled mid-job, runner setup failure)
- **AND** no assertion-class signal is present in the failed set
- **THEN** the gate SHALL classify the failure set as `infra`

#### Scenario: assertion output classifies as assertion

- **WHEN** definitive failures are present
- **AND** log excerpt or check description contains product assertion/compiler/lint failure signals
- **THEN** the gate SHALL classify the failure set as `assertion`

#### Scenario: no confident match classifies as unknown

- **WHEN** definitive failures are present
- **AND** neither infra nor assertion rules match confidently
- **THEN** the gate SHALL classify the failure set as `unknown`

#### Scenario: mixed assertion and infra prefers assertion

- **WHEN** one failed check matches infra signatures and another matches assertion signals
- **THEN** the overall classification SHALL be `assertion`

### Requirement: The gate SHALL apply a durable per-head-SHA bounded recovery budget before needs-human

For each PR head SHA observed with definitive CI failures, the gate SHALL track recovery steps already consumed in durable run state that survives process restart. The budget SHALL include, in order and as applicable: the existing one-shot rebase (when not yet attempted), at most one automatic failed-workflow re-run for `infra` or `unknown`, at most one archive-only failed-run recovery step when archive-only and prior-green conditions hold, and at most one assertion auto-fix attempt when that feature is enabled and classification is `assertion`. After the applicable budget is exhausted, the gate SHALL escalate once and SHALL NOT re-attempt the same recovery step for the same head SHA. The budget SHALL NOT reintroduce infinite wait or re-archive loops (#181).

Before returning `waiting` after a budget-consuming recovery side-effect (re-run, archive close+reopen, assertion fix), the gate SHALL successfully persist the corresponding durable marker (canonical run directory / run-store path). When the run directory is absent or marker persistence fails, the gate SHALL NOT perform the recovery side-effect when it has not yet occurred, SHALL NOT return `waiting` solely on in-memory markers, and SHALL escalate with `ci-exhausted` naming the persistence failure so a restarted process cannot re-consume the budget unboundedly.

#### Scenario: durable markers prevent re-run after process restart

- **WHEN** a re-run was already recorded as attempted for head SHA `H` in durable run state
- **AND** a new process resumes pre-merge on the same run with the same head SHA `H` still red
- **THEN** the gate SHALL NOT call the re-run seam again for `H`
- **AND** SHALL continue with remaining budget steps or escalate

#### Scenario: new head SHA resets recovery budget

- **WHEN** the PR head advances to a new SHA `H2` distinct from the SHA whose budget was consumed
- **THEN** the gate SHALL treat recovery markers as applying per SHA so `H2` may receive its own one-shot re-run budget
- **AND** SHALL NOT reuse “already attempted” from `H1` to skip all recovery on `H2`

#### Scenario: definitive red never infinite-waits without budget progress (#181)

- **WHEN** checks are definitively failed and no remaining recovery step applies for the head SHA
- **THEN** the gate SHALL call `setBlocked` and return `blocked`
- **AND** SHALL NOT return `{ status: "waiting", reason: "CI still running" }` solely because checks are red
- **AND** SHALL NOT push another OpenSpec archive solely to re-poll CI

#### Scenario: marker persistence failure refuses recovery side-effect and escalates

- **WHEN** definitive failures classify as eligible for re-run (or archive close+reopen / assertion fix)
- **AND** durable marker persistence fails or the run directory is unavailable
- **THEN** the gate SHALL NOT call the corresponding recovery side-effect seam
- **AND** SHALL NOT return `waiting`
- **AND** SHALL call `setBlocked` with kind `ci-exhausted` and a reason that names the persistence failure

### Requirement: Infra or unknown classification SHALL trigger at most one automatic failed-workflow re-run

When the overall classification is `infra` or `unknown`, the per-head re-run marker is unset, and re-run is still in budget, the gate SHALL invoke the injectable re-run seam once to re-run failed workflow run(s) associated with the failing checks, record the durable re-run-attempted marker for the head SHA, and return `waiting` so the next poll observes fresh check status. If the re-run seam cannot resolve a run id or the re-run call fails, the gate SHALL record the attempt (or explicitly record re-run unavailable) and proceed to the next budget step without looping. A second definitive red for the same head after a completed re-run attempt SHALL NOT re-run again.

#### Scenario: first infra fail re-runs once and waits

- **WHEN** `getPrChecks` returns definitive failures classified as `infra`
- **AND** re-run has not yet been attempted for the current head SHA
- **AND** the re-run seam succeeds in requesting a re-run
- **THEN** the gate SHALL call the re-run seam exactly once
- **AND** SHALL persist re-run-attempted for that head SHA
- **AND** SHALL return `{ advanced: false, status: "waiting" }` with a reason indicating CI was re-triggered
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: second fail after re-run escalates without another re-run

- **WHEN** definitive failures remain for the same head SHA
- **AND** re-run-attempted is already set for that SHA
- **AND** no further applicable recovery steps remain
- **THEN** the gate SHALL NOT call the re-run seam
- **AND** SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** SHALL return `blocked`

#### Scenario: simulated flake then green advances without needs-human

- **WHEN** unit tests inject a first poll of definitive infra failure and a successful re-run seam
- **AND** a subsequent poll injects all-pass checks for the same head
- **THEN** the gate SHALL advance past the CI step without calling `setBlocked` for CI failure

### Requirement: Archive-only red head with prior green SHALL prefer recovery over immediate hard block

When definitive failures are observed, the diff from `preArchiveSha` to the current head touches only paths under `openspec/`, the pre-archive SHA had at least one successful check-run, and classification is `infra` or `unknown`, the gate SHALL prefer automatic recovery (failed-workflow re-run first; if re-run budget is already consumed or re-run is unavailable, at most one close+reopen-family recovery for this failed-run archive path) over immediate `setBlocked` on the first red. Close+reopen for this path SHALL be one-shot per head SHA (separate durable marker from zero-run recovery) and on success SHALL return `waiting`. This extends #281 from zero runs to failed runs that look non-product. Assertion-classified archive-only heads SHALL NOT use close+reopen to paper over product failures.

#### Scenario: archive-only + prior green + infra — re-run before block

- **WHEN** definitive failures classify as `infra`
- **AND** `preArchiveSha..headSha` paths are all under `openspec/`
- **AND** the pre-archive SHA had successful check-runs
- **AND** re-run has not been attempted for the head SHA
- **THEN** the gate SHALL attempt re-run and return `waiting`
- **AND** SHALL NOT call `setBlocked` on that first red tick

#### Scenario: archive-only + prior green after re-run exhausted — one close+reopen then wait

- **WHEN** definitive failures classify as `infra` or `unknown`
- **AND** archive-only and prior-green conditions hold
- **AND** re-run was already attempted (or re-run unavailable) for the head SHA
- **AND** archive failed-run close+reopen has not been attempted for the head SHA
- **THEN** the gate SHALL call `closePr` then `reopenPr` once
- **AND** SHALL return `waiting`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: archive close succeeds but reopen fails — reopen retry then escalate with closed-PR guidance

- **WHEN** archive close+reopen recovery is selected for the head SHA
- **AND** `closePr` succeeds
- **AND** the first `reopenPr` fails
- **THEN** the gate SHALL retry `reopenPr` once
- **AND** when reopen still fails, SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** the block reason SHALL state that the PR is still closed and direct the operator to reopen it
- **AND** SHALL record the archive failed-run recovery marker so close+reopen is not thrashed

#### Scenario: archive-only assertion failure does not close+reopen to hide product red

- **WHEN** definitive failures classify as `assertion`
- **AND** the head is archive-only with prior green
- **THEN** the gate SHALL NOT call close+reopen solely because the head is archive-only
- **AND** SHALL follow assertion budget (optional one-shot fix if enabled, else escalate)

### Requirement: Optional config-capped assertion auto-fix SHALL be at most one shot per head SHA

When configuration enables pre-merge CI assertion auto-fix and the overall classification is `assertion`, and the durable assertion-fix-attempted marker is unset for the head SHA, the gate MAY invoke exactly one surgical implementer fix attempt, push the result, mark assertion-fix-attempted for that SHA, and return `waiting` for CI. When the feature is disabled or the marker is already set, the gate SHALL NOT invoke automatic code fix for CI assertion failures. Exhaustion SHALL escalate with `ci-exhausted`. This path SHALL NOT loop without the durable marker and SHALL NOT expand into multi-round free-form fix without a further budgeted design.

#### Scenario: assertion fix disabled escalates without auto-fix

- **WHEN** classification is `assertion`
- **AND** assertion auto-fix is disabled in config
- **AND** other recovery steps do not apply
- **THEN** the gate SHALL NOT invoke the assertion-fix seam
- **AND** SHALL call `setBlocked` with kind `ci-exhausted`

#### Scenario: assertion fix enabled runs once then stops

- **WHEN** classification is `assertion`
- **AND** assertion auto-fix is enabled
- **AND** assertion-fix-attempted is unset for the head SHA
- **THEN** the gate SHALL invoke the assertion-fix seam at most once, persist the marker, and return `waiting` on success of the attempt dispatch
- **AND** on a later poll with the same head still red and the marker set, SHALL NOT invoke the seam again and SHALL escalate when budget is exhausted

### Requirement: CI recovery SHALL NOT waive required checks

The pre-merge gate SHALL advance past the GitHub CI step only when checks aggregate to pass (no definitive failures and not pending), or when `ci_mode` is `local` under that mode's existing requirements. Re-run, close+reopen, rebase, and assertion fix SHALL only re-enter `waiting` or produce a new head to re-verify; they SHALL NOT treat red checks as green and SHALL NOT skip required checks.

#### Scenario: after recovery, green is required to advance

- **WHEN** a re-run or close+reopen recovery completed earlier
- **AND** a later poll still reports definitive failures with budget exhausted
- **THEN** the gate SHALL block rather than advance to mergeability as if CI passed

#### Scenario: all-pass after recovery advances

- **WHEN** a later poll reports no pending and no failed checks
- **THEN** the gate SHALL proceed to the mergeability step without calling `setBlocked` for CI failure

