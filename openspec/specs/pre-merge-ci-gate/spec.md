# pre-merge-ci-gate Specification

## Purpose
TBD - created by archiving change pre-merge-gate-convergence. Update Purpose after archive.
## Requirements
### Requirement: CI failure with rebase guard exhausted blocks to needs-human

When CI check runs are definitively failing (not pending), the pre-merge gate SHALL first apply the bounded recovery ladder defined by the "bounded CI recovery budget" requirements in this capability. Only after that budget is exhausted for the current head SHA SHALL the gate call `setBlocked` and return `blocked`. When escalating, the gate SHALL use blocker kind `ci-exhausted` (not a bare generic `needs-human` without classification) and a reason that names each failing check. It SHALL NOT return unbounded `waiting` solely because checks are red, and SHALL NOT re-enter an archive/poll spin loop (#181 non-regression). A successful one-shot rebase SHALL return `waiting` with reason `rebased; CI re-running` **only when the PR head SHA actually changed** as a result of that rebase; a no-op rebase that leaves HEAD unchanged SHALL consume the one-shot rebase budget for that head SHA and continue the ladder or escalate rather than thrash on that reason.

#### Scenario: CI failing, recovery budget exhausted — block immediately

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** the per-head-SHA recovery budget for this head is exhausted (rebase policy applied as configured, re-run already attempted or inapplicable, archive-only recovery already attempted or inapplicable, assertion auto-fix already attempted or disabled/inapplicable)
- **THEN** the gate SHALL call `setBlocked` with kind `ci-exhausted` and a reason listing the failing check names
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "CI failed" }` (or an equivalent blocked reason that identifies CI exhaustion)
- **AND** SHALL NOT return `waiting` or attempt another automatic recovery for the same head SHA

#### Scenario: CI failing, first rebase succeeds and moves HEAD — wait for CI to re-run

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase recovery side-effect succeeds **and** the PR head SHA changes
- **THEN** the gate SHALL mark the rebase as attempted for that head (durable per-head marker)
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: CI failing, rebase attempt fails — continue recovery ladder (not instant generic block)

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase recovery side-effect fails (rebase or push could not complete)
- **THEN** the gate SHALL NOT treat rebase failure alone as the end of all recovery when further budget steps remain (classification / re-run / archive-aware recovery / optional assertion fix)
- **AND** when no further recovery step applies, SHALL escalate with `ci-exhausted` as in the budget-exhausted scenario

#### Scenario: CI failing, rebase no-op (HEAD unchanged) — consume budget, do not thrash wait

- **WHEN** `getPrChecks` returns one or more definitively-failed check runs
- **AND** rebase has not yet been attempted for the current head SHA
- **AND** the rebase/push side-effect reports success but the PR head SHA does not change
- **THEN** the gate SHALL mark rebase as attempted for that head SHA
- **AND** SHALL NOT return `{ status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL continue the recovery ladder or escalate when budget is exhausted

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

### Requirement: Settled CI failure at a head SHA SHALL not thrash rebase or unbounded partial waits

When required checks aggregate to **settled failure** — one or more definitive failures (`fail` / `cancel` or equivalent) and **no** pending checks — the pre-merge CI gate SHALL NOT re-enter a recovery path that claims a fresh rebase (or equivalent recovery side-effect) for the same head SHA after that recovery class’s one-shot budget for that SHA has already been consumed. After the applicable per-head recovery budget is exhausted, the gate SHALL call `setBlocked` with kind `ci-exhausted` (offramp class `ci-failed` on the blocked outcome), return `blocked`, and SHALL NOT return `waiting` solely because the same red tip is re-polled. This requirement tightens #181 / #679 against poll thrash when GitHub checks are already red.

#### Scenario: Settled failure with recovery budget exhausted blocks once

- **WHEN** `getPrChecks` returns one or more definitively failed checks and zero pending checks for head SHA `H`
- **AND** the per-head recovery budget for `H` is exhausted (rebase attempted, re-run/archive/assertion steps attempted or inapplicable)
- **THEN** the gate SHALL return `{ advanced: false, status: "blocked" }` with CI exhaustion classification
- **AND** SHALL call `setBlocked` with kind `ci-exhausted`
- **AND** SHALL NOT call `tryRebaseAndPush` again for `H` on subsequent polls while head remains `H`

#### Scenario: Multiple poll hops on the same red head do not repeat rebase side-effect

- **WHEN** unit tests inject settled `failure` checks at head `H` across two or more `advance` (or poll) hops
- **AND** the rebase recovery class has already been consumed for `H`
- **THEN** the fake `tryRebaseAndPush` seam SHALL record at most one invocation for `H`
- **AND** the second hop SHALL block rather than return `{ status: "waiting", reason: "rebased; CI re-running" }`

#### Scenario: Pending checks still wait (no false settle)

- **WHEN** `getPrChecks` reports at least one pending check for the head SHA
- **THEN** the gate SHALL return `{ advanced: false, status: "waiting" }` (e.g. reason `CI still running` or an equivalent pending wait)
- **AND** SHALL NOT treat the aggregate as settled failure solely because another check is red
- **AND** SHALL NOT call `setBlocked` for CI exhaustion on that pending tick

### Requirement: Waiting reason `rebased; CI re-running` SHALL require observable HEAD movement or explicit re-request

The gate SHALL return reason `rebased; CI re-running` only when a recovery side-effect **actually moved the PR head SHA** relative to the SHA observed when the recovery began, or when workflows were **explicitly re-requested** and checks remain pending. A no-op rebase (exit success without HEAD change) or a re-poll of the same red tip SHALL NOT use that reason. When a rebase is attempted for head `H` and HEAD does not move, the gate SHALL still consume the one-shot rebase budget for `H` and SHALL continue the remaining recovery ladder or escalate — it SHALL NOT return unbounded `waiting` with a false re-running claim.

#### Scenario: Rebase moves HEAD — wait for CI

- **WHEN** `getPrChecks` returns definitive failures for head SHA `H1`
- **AND** rebase has not yet been attempted for `H1`
- **AND** the rebase recovery side-effect succeeds and the PR head becomes a distinct SHA `H2`
- **THEN** the gate SHALL mark rebase attempted for the pre-move head (and/or new head per durable markers)
- **AND** SHALL return `{ advanced: false, status: "waiting", reason: "rebased; CI re-running" }`
- **AND** SHALL NOT call `setBlocked` on that tick

#### Scenario: Rebase succeeds but HEAD unchanged — do not claim re-running

- **WHEN** `getPrChecks` returns definitive failures for head SHA `H`
- **AND** rebase has not yet been attempted for `H`
- **AND** the rebase/push side-effect reports success but the PR head remains `H`
- **THEN** the gate SHALL consume the one-shot rebase budget for `H`
- **AND** SHALL NOT return reason `rebased; CI re-running`
- **AND** SHALL continue remaining recovery steps or escalate to `ci-exhausted` when no further steps apply
- **AND** a subsequent poll with the same head still red SHALL NOT invoke rebase again

#### Scenario: Explicit workflow re-request may wait without HEAD move

- **WHEN** classification selects the infra/unknown re-run path and the re-run seam successfully re-requests failed workflows for head `H`
- **THEN** the gate MAY return `waiting` with a reason that indicates CI was re-triggered
- **AND** SHALL NOT use the string `rebased; CI re-running` unless a rebase also moved HEAD

### Requirement: Rebase recovery budget SHALL be durable per head SHA

The one-shot rebase recovery for definitive CI failure SHALL be tracked against the PR head SHA in durable run state that survives process restart (the same durability class as re-run / archive-fail / assertion-fix markers under the pre-merge CI recovery store). Relying solely on a worktree-local marker that can be lost when the worktree is recreated SHALL NOT be sufficient to re-open unlimited rebase attempts for the same failed head. When durable marker persistence fails and the run directory is unavailable, the gate SHALL NOT return unbounded `waiting` on in-memory-only rebase state; it SHALL escalate with `ci-exhausted` naming the persistence failure (consistent with #679 marker durability).

#### Scenario: Durable rebase marker prevents re-rebase after process restart

- **WHEN** a rebase was already recorded as attempted for head SHA `H` in durable run state
- **AND** a new process resumes pre-merge with the same head SHA `H` still settled red
- **THEN** the gate SHALL NOT call `tryRebaseAndPush` again for `H`
- **AND** SHALL continue remaining budget steps or escalate

#### Scenario: New head SHA may receive its own one-shot rebase

- **WHEN** the PR head advances to a new SHA `H2` distinct from the SHA whose rebase budget was consumed
- **THEN** the gate SHALL allow at most one rebase attempt for `H2` under the same rules
- **AND** SHALL NOT treat “already rebased for `H1`” as permanent suppression for all future heads without re-evaluation

#### Scenario: Same-worktree secondary marker must not suppress a later head’s rebase budget

- **WHEN** rebase budget was consumed for head SHA `H1` and a worktree-local secondary rebase marker was left in the issue worktree
- **AND** the PR head advances to a distinct head SHA `H2` while that same worktree (and its secondary marker) remains present
- **AND** durable run state has not yet recorded a rebase attempt for `H2`
- **THEN** the gate SHALL allow at most one rebase attempt for `H2`
- **AND** SHALL NOT treat the unkeyed worktree secondary marker alone as authorization to skip `H2`’s durable one-shot

#### Scenario: Force-push back to a previously consumed head retains that head’s budget

- **WHEN** rebase budget was consumed for head SHA `H1` and later for a distinct head SHA `H2`
- **AND** the PR head is force-pushed back to `H1` (or otherwise returns to `H1`)
- **AND** a new process or empty polling context resumes pre-merge with durable run state for the same run directory
- **THEN** the gate SHALL NOT call `tryRebaseAndPush` again for `H1`
- **AND** SHALL retain `H1` (and `H2`) in the durable per-class recovery marker set rather than overwriting a single latest-SHA scalar

#### Scenario: Successful rebase with unverified post-rebase HEAD re-evaluates without escalating

- **WHEN** the rebase/push side-effect reports success for head SHA `H`
- **AND** the authoritative post-rebase `getPrDetail` head read fails or returns no SHA
- **THEN** the gate SHALL consume the one-shot rebase budget for `H`
- **AND** SHALL return `{ advanced: false, status: "waiting" }` with a re-evaluation reason (not `rebased; CI re-running`)
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted` on that tick using the pre-rebase failed checks alone

### Requirement: Escalated settled CI failure SHALL emit a terminal CI gate_result fail

When the gate escalates from settled CI failure (budget exhausted), it SHALL record a durable `gate_result` for gate `ci` with `result: "fail"` (or the established blocked equivalent already used by pre-merge observability) including a reason that identifies CI failure. For a given failed head SHA after escalation, the gate SHALL NOT emit an unbounded sequence of `gate_result` rows with `result: "partial"` and reason `rebased; CI re-running` on pure re-polls that perform no new recovery side-effect.

#### Scenario: Block path writes ci fail once

- **WHEN** the gate returns `blocked` due to CI recovery budget exhaustion for head `H`
- **THEN** the run event stream SHALL contain a `gate_result` with `gate: "ci"` and `result: "fail"`
- **AND** the reason SHALL name CI failure and/or failing checks sufficiently for operators

#### Scenario: Pure re-poll of unchanged red head does not spam partial rebased rows

- **WHEN** head SHA `H` is settled red and rebase budget for `H` is already consumed
- **AND** a poll performs no new recovery side-effect and escalates or remains blocked
- **THEN** the run SHALL NOT append additional `gate_result` rows with `result: "partial"` and reason `rebased; CI re-running` for that re-poll

#### Scenario: Terminal ci fail is idempotent per failed head SHA

- **WHEN** the gate has already recorded a terminal `gate_result` `ci`/`fail` for head SHA `H`
- **AND** a pure re-poll observes the same head still settled red with recovery budgets exhausted
- **THEN** the gate SHALL NOT append another terminal `ci`/`fail` solely for that re-poll
- **AND** SHALL still return `blocked` (not unbounded `waiting`)

#### Scenario: Terminal ci fail remains idempotent when only runDir is provided

- **WHEN** `advance` is invoked with a run directory and without an in-memory `pollingCtx`
- **AND** the gate has already recorded a terminal `gate_result` `ci`/`fail` for head SHA `H` in durable run state
- **AND** a subsequent invocation observes the same head still settled red with recovery budgets exhausted
- **THEN** the gate SHALL NOT append another terminal `ci`/`fail` solely for that re-poll
- **AND** SHALL still return `blocked`

#### Scenario: Terminal ci fail claim is durable before event append

- **WHEN** the gate escalates to `blocked` for settled CI failure at head SHA `H` and has not yet claimed a terminal fail for `H`
- **THEN** the gate SHALL persist the per-head terminal-fail claim in durable run state before appending the terminal `gate_result` `ci`/`fail` event
- **AND** when durable claim persistence fails, the gate SHALL NOT append the terminal fail event on that tick (so a later successful claim can emit exactly once)
- **AND** when the durable claim is present for `H` after a crash that prevented the event append, a subsequent pure re-poll SHALL NOT append a terminal `ci`/`fail` solely for that re-poll

### Requirement: Settled-check aggregate SHALL be pending-first for the current PR head

The pre-merge CI gate SHALL evaluate settlement using the checks returned for the PR at poll time against the **current** PR head SHA from `getPrDetail`. Any pending check (bucket not `pass`/`skipping`/`fail`/`cancel`) SHALL take precedence over failure: the gate SHALL return `waiting` and SHALL NOT enter definitive-failure recovery or `ci-exhausted` while pending remains. Neutral/skipped (`skipping`) checks SHALL NOT count as failure or pending. Immediately after a settled-failure check poll and before entering definitive-failure recovery, the gate SHALL re-read `getPrDetail`; if the head SHA differs from the SHA observed when the poll began, the gate SHALL return `waiting` without recovery side-effects so the next tick re-evaluates the new head.

#### Scenario: Red plus pending waits without recovery

- **WHEN** `getPrChecks` reports at least one failed check and at least one pending check for the current PR head
- **THEN** the gate SHALL return `{ status: "waiting" }`
- **AND** SHALL NOT call `tryRebaseAndPush` or other definitive-failure recovery side-effects on that tick
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted`

#### Scenario: Concurrent head change during check poll skips recovery

- **WHEN** `getPrChecks` returns settled failure for the head SHA observed when the poll began (`H1`)
- **AND** a re-read of `getPrDetail` immediately after that poll reports a distinct head SHA `H2`
- **THEN** the gate SHALL return `{ status: "waiting" }` (re-evaluation / head-advanced wait)
- **AND** SHALL NOT call `tryRebaseAndPush` or other definitive-failure recovery side-effects on that tick
- **AND** SHALL NOT consume per-head recovery budget markers for `H1` on that tick
- **AND** SHALL NOT call `setBlocked` with kind `ci-exhausted` on that tick

### Requirement: CI recovery persistence failure SHALL fail closed

When the durable CI recovery marker store cannot be written or read-back-verified before a recovery side-effect that would consume budget, the gate SHALL refuse that side-effect and SHALL escalate with `ci-exhausted` naming the persistence failure rather than returning unbounded `waiting` on in-memory-only state. This applies to rebase as well as re-run / archive / assertion classes. Marker writes SHALL be atomic (same-directory temporary file then rename) so an interrupted write cannot leave a truncated file. A missing initial marker file SHALL be treated as empty budgets; a malformed or unreadable existing marker file SHALL be treated as a persistence failure and fail closed before any recovery side-effect (not as an empty budget that re-opens consumed heads).

#### Scenario: Marker write failure refuses side-effect and blocks

- **WHEN** settled failure would authorize a recovery class attempt for head `H`
- **AND** persisting the per-class attempt marker fails or runDir is unavailable
- **THEN** the gate SHALL NOT perform that recovery side-effect (or SHALL not claim a successful recovery wait after an undurable attempt)
- **AND** SHALL escalate with `ci-exhausted` including a durable-persistence failure signal in the operator reason

#### Scenario: Corrupt existing marker file fails closed without re-opening budgets

- **WHEN** the durable CI recovery marker file exists but is truncated, malformed, or otherwise unreadable
- **AND** settled failure would otherwise authorize a recovery class attempt for head `H`
- **THEN** the gate SHALL NOT call `tryRebaseAndPush` (or other recovery side-effects) for `H`
- **AND** SHALL escalate with `ci-exhausted` naming the persistence / unreadable-marker failure
- **AND** SHALL NOT treat the unreadable file as an empty marker set that re-opens a previously consumed budget

### Requirement: Escalation evidence SHALL include failing checks and optional capped logs

When escalating settled CI failure, the block reason SHALL name each failing check. A log excerpt SHALL be included only when retrieval succeeds and SHALL be size-capped. Failure to fetch logs SHALL NOT prevent blocking and SHALL NOT cause additional recovery waits.

#### Scenario: Log fetch failure still blocks with check names

- **WHEN** recovery budget is exhausted for head `H` with settled failed checks
- **AND** log excerpt retrieval returns null or throws
- **THEN** the gate SHALL still call `setBlocked` with kind `ci-exhausted`
- **AND** the reason SHALL list failing check names
- **AND** SHALL return `blocked`

### Requirement: CI recovery durable state SHALL be the stage-attempt ledger

For each PR head SHA observed with definitive CI failures, the gate SHALL track recovery steps
already consumed through the stage-attempt ledger (shared recovery-attempt family), not through a
private `pre-merge-ci-recovery.json` authority. Actions SHALL include at least: rebase,
failed-workflow re-run, archive-fail recovery, and assertion-fix when enabled. Product ladder order
and one-shot-per-head budgets remain as specified by existing durable-budget requirements; only the
authority store consolidates. Migration MAY read legacy runDir JSON once into the ledger.

#### Scenario: Restart without pre-merge-ci-recovery.json honors ledger re-run attempt

- **WHEN** the ledger records workflow re-run attempted for head `H`
- **AND** `pre-merge-ci-recovery.json` is absent on resume
- **AND** head `H` is still settled red
- **THEN** the gate SHALL NOT re-request workflow re-run for `H`
- **AND** SHALL continue remaining budget steps or escalate with `ci-exhausted`

#### Scenario: Claim-before-side-effect for CI recovery actions

- **WHEN** the gate is about to invoke rebase, re-run, archive-fail recovery, or assertion-fix for
  head `H`
- **THEN** it SHALL claim the corresponding ledger action for `H` before the side effect
- **AND** on claim persistence failure SHALL fail closed without performing the side effect

#### Scenario: New code does not require writing pre-merge-ci-recovery.json

- **WHEN** a CI recovery attempt completes for head `H`
- **THEN** the durable authority write SHALL go through the stage-attempt ledger
- **AND** production correctness SHALL NOT depend on creating or updating
  `pre-merge-ci-recovery.json`

### Requirement: Local test-gate fail rows SHALL be SHA-matched before blocking the live head

When `cfg.ci_mode` is `"local"`, the pre-merge CI gate SHALL read the most-recent test-gate outcome and its `pr_head_sha` as today. A recorded **failure** SHALL authorize a local-mode block or suite-fail disposition only when `pr_head_sha` equals the live open PR head. When `pr_head_sha` differs from the live head, or is absent (legacy), the gate SHALL NOT treat that failure as certification that the live head failed: it SHALL fail closed against using the stale row as live-head fail authority (no advance on a stale pass remains as already specified) and SHALL require a fresh test-gate result for the live head (or an explicit blocked reason that the live head lacks current local certification) rather than replaying `test-gate-exhausted` text keyed only to the old SHA.

#### Scenario: Stale failure for prior head does not fail local mode for new head

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a failure with `pr_head_sha = H_fail`
- **AND** the live PR head is `H_green` where `H_green ≠ H_fail`
- **THEN** the gate SHALL NOT call `setBlocked` solely with a suite-fail / `test-gate-exhausted` reason that only names the prior-head failure as current
- **AND** SHALL NOT advance on that stale failure row as if it were a pass

#### Scenario: Current-head failure still blocks local mode

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a failure with `pr_head_sha` equal to the live PR head H
- **THEN** the gate SHALL NOT advance
- **AND** SHALL call `setBlocked` with a reason that names the failed local test gate and head H under existing local-mode failure contracts

#### Scenario: Stale pass still fail-closed (non-regression)

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the most-recent test-gate outcome is a pass whose `pr_head_sha` does not match the live PR head
- **THEN** the gate SHALL still block with `needs-human` under the existing stale-pass rule
- **AND** SHALL NOT treat the earlier pass as certification of the current head

#### Scenario: Inline local gate results are authoritative only when worktree HEAD equals live PR head

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the gate runs the inline local test command against the managed worktree
- **AND** the managed worktree HEAD differs from the live open PR head (lagging at a prior fail SHA, or ahead with unpushed commits)
- **THEN** the gate SHALL NOT treat that inline pass or failure as suite-fail / `test-gate-exhausted` certification of the live head
- **AND** SHALL block with an operational worktree-sync / fresh-certification reason that names both SHAs
- **AND** SHALL NOT advance on the mismatched inline result as if it certified the live head

#### Scenario: Inline fail at matching live-head worktree still suite-fails

- **WHEN** `cfg.ci_mode` is `"local"`
- **AND** the inline local test gate fails
- **AND** the managed worktree HEAD equals the live open PR head H
- **THEN** the gate SHALL block under existing local-mode suite-fail contracts for H

---

### Requirement: GitHub-mode green checks on the live head SHALL outrank superseded local fail narrative

When `cfg.ci_mode` is `"github"` and `getPrChecks` (or equivalent) reports definitive success for the live open PR head H, the pre-merge CI step SHALL treat H as CI-green for gate purposes even if run-local `tester_evidence` or `stage_accounting` test-gate rows record a failure for a different SHA A ≠ H. Those superseded fail rows SHALL NOT alone divert the CI step into `ci-exhausted` / suite-fail block for H. Pending or failed checks on H continue under existing recovery and exhaustion requirements for H.

#### Scenario: Green github checks on live head ignore prior-head local fail

- **WHEN** `cfg.ci_mode` is `"github"`
- **AND** checks for live head `H_green` are successful
- **AND** run-local test-gate or tester-evidence fail rows name only `H_fail ≠ H_green`
- **THEN** the CI step SHALL proceed as green for `H_green` under existing post-green mergeability / OpenSpec steps
- **AND** SHALL NOT return `blocked` solely from the prior-head local fail rows

#### Scenario: Failed checks on live head still enter recovery

- **WHEN** `cfg.ci_mode` is `"github"` and checks for live head H are definitively failing
- **THEN** the gate SHALL enter the existing per-head recovery ladder for H
- **AND** SHALL NOT skip recovery because a different historical SHA had green checks

