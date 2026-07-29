## MODIFIED Requirements

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

## ADDED Requirements

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
