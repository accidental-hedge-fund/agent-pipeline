## ADDED Requirements

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
