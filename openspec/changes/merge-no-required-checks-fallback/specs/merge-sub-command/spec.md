## MODIFIED Requirements

### Requirement: The `merge` sub-command SHALL verify required status checks before merging
After confirming mergeability, the handler SHALL call `gh pr checks <pr> --required --json name,bucket` to obtain only the checks that branch protection marks as required, and SHALL refuse to merge if any required check has not passed. Optional checks (pending, skipped, or failed) are not returned by `--required` and SHALL NOT block the merge. The `bucket` field categorises each check as `pass`, `fail`, `pending`, `skipping`, or `cancel`; only `pass` and `skipping` are non-blocking.

When `gh pr checks --required` exits non-zero and its stderr contains the substring "no required checks reported", the handler SHALL NOT treat this as a hard failure. Instead it SHALL enter the no-required-checks fallback path described in the "Fallback when no required checks are configured" requirement below.

Any other non-zero exit from `gh pr checks --required` (for example an auth error or network error) SHALL remain a hard failure and the handler SHALL exit non-zero without merging.

#### Scenario: All required checks passing
- **WHEN** all required checks have bucket `pass` or `skipping`
- **THEN** the handler proceeds to the issue-stage gate

#### Scenario: Any required check failing or pending
- **WHEN** any required check has bucket `fail`, `pending`, or `cancel`
- **THEN** the handler SHALL exit non-zero with a message naming the failing or pending check(s) and SHALL NOT merge

#### Scenario: Optional checks do not block
- **WHEN** `gh pr checks --required` returns only passing required checks but optional checks have other states
- **THEN** the handler SHALL proceed to the issue-stage gate and SHALL NOT block on optional check states

#### Scenario: `gh pr checks --required` exits with "no required checks reported" — fallback entered
- **WHEN** `gh pr checks --required` exits non-zero and stderr contains "no required checks reported"
- **THEN** the handler SHALL NOT exit non-zero at this point
- **AND** SHALL enter the fallback path (see "Fallback when no required checks are configured")

#### Scenario: `gh pr checks --required` exits with an unrelated error — hard failure preserved
- **WHEN** `gh pr checks --required` exits non-zero and stderr does NOT contain "no required checks reported"
- **THEN** the handler SHALL exit non-zero surfacing the `gh` error output and SHALL NOT merge

---

### Requirement: Fallback when no required checks are configured
When `gh pr checks --required` reports that no required checks are configured on the base branch, the merge handler SHALL verify safety via an alternative path before proceeding. The handler SHALL call `gh pr checks <pr> --json name,bucket` (without `--required`) to obtain all observable check results. It SHALL block the merge if any check has bucket `fail`, `pending`, or `cancel`. Only if all checks have bucket `pass` or `skipping` (or the list is empty) SHALL the handler proceed to the issue-stage gate. The `ghPrChecksAll` call SHALL be injectable via `MergeDeps` so that unit tests can supply fixture results without any real subprocess.

#### Scenario: No required checks configured, all observable checks green — fallback passes
- **WHEN** `gh pr checks --required` exits with the "no required checks reported" message
- **AND** `gh pr checks <pr>` (without `--required`) returns only `pass` or `skipping` buckets (or an empty list)
- **THEN** the handler SHALL proceed to the issue-stage gate and SHALL NOT exit non-zero at this point

#### Scenario: No required checks configured, an observable check is failing — fallback blocks
- **WHEN** `gh pr checks --required` exits with the "no required checks reported" message
- **AND** `gh pr checks <pr>` returns at least one check with bucket `fail`
- **THEN** the handler SHALL exit non-zero with a message naming the failing check(s) and their buckets
- **AND** SHALL NOT merge

#### Scenario: No required checks configured, an observable check is pending — fallback blocks
- **WHEN** `gh pr checks --required` exits with the "no required checks reported" message
- **AND** `gh pr checks <pr>` returns at least one check with bucket `pending` or `cancel`
- **THEN** the handler SHALL exit non-zero with a message naming the pending/cancelled check(s)
- **AND** SHALL NOT merge

#### Scenario: No required checks configured, `gh pr checks` exits with "no checks reported" — fallback treats as empty and passes
- **WHEN** `gh pr checks --required` exits with the "no required checks reported" message
- **AND** `gh pr checks <pr>` (without `--required`) itself exits non-zero with a message containing "no checks reported"
- **THEN** the handler SHALL treat this as an empty check list (equivalent to zero observable checks)
- **AND** SHALL proceed to the issue-stage gate and SHALL NOT exit non-zero at this point

#### Scenario: Unit test injects fake `ghPrChecksAll` via `MergeDeps`
- **WHEN** a unit test constructs `MergeDeps` with a stubbed `ghPrChecksAll` that returns a fixture list of check results
- **AND** `ghPrChecksRequired` is stubbed to return the "no required checks" error
- **THEN** `mergePr` exercises the fallback path using the fixture data without any real `gh` subprocess

---

### Requirement: The `merge` sub-command logic SHALL be behind a `MergeDeps` dependency-injection seam
All I/O (calls to `gh pr view`, `gh pr checks --required`, `gh pr checks` (fallback), `gh pr merge`, and issue-label inspection) SHALL be injected via a `MergeDeps` interface parameter. The real production deps call `gh`; test deps return fixtures. Unit tests SHALL NOT make any real network, git, or subprocess call.

#### Scenario: Unit test uses fake deps
- **WHEN** a unit test constructs a `MergeDeps` with stubbed `ghPrView`, `ghPrChecksRequired`, `ghPrChecksAll`, `ghPrMerge`, and `getIssueLabels` implementations
- **THEN** running `mergePr(prNumber, deps)` exercises the gate logic without any real `gh` subprocess

#### Scenario: Production code uses real deps
- **WHEN** the `pipeline merge` CLI dispatches the handler in production
- **THEN** it passes `realMergeDeps()` which shells out to `gh` for all I/O
