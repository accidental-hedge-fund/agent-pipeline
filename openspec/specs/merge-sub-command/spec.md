# merge-sub-command Specification

## Purpose
TBD - created by archiving change pipeline-merge-pr-human-invoked. Update Purpose after archive.
## Requirements
### Requirement: The `merge` sub-command is a human-only CLI surface
The pipeline CLI SHALL accept `merge` as a positional sub-command keyword that takes a single PR number argument and that is never invoked by the autonomous `advance` loop. It SHALL be dispatched when the first positional argument is the string `merge` (case-sensitive).

#### Scenario: Invoked by a human with a PR number
- **WHEN** the user runs `pipeline merge 42`
- **THEN** the command dispatches the merge handler with PR number 42 and does not advance any pipeline stage label

#### Scenario: Missing PR number exits with a usage error
- **WHEN** the user runs `pipeline merge` with no PR number
- **THEN** the command SHALL exit non-zero with a usage error indicating that a PR number is required

#### Scenario: Non-numeric argument is rejected
- **WHEN** the user runs `pipeline merge foo` where `foo` is not a positive integer
- **THEN** the command SHALL exit non-zero with an error indicating that a numeric PR number is required

---

### Requirement: The `merge` sub-command SHALL reject every global flag outside its allowlist
The `merge` handler resolves configuration from only `--repo-path`, `--base`, and `--profile`. The CLI SHALL therefore enforce these three as an explicit allowlist: any other CLI option that is explicitly provided on a `pipeline merge` invocation SHALL be rejected with exit code 2 and an error naming the offending flag(s), evaluated BEFORE the irreversible squash merge — and before any other mode-specific flag validation — is reached. The check SHALL be allowlist-based (reject everything not allowed) rather than denylist-based, so that a newly added global option cannot silently leak into the merge path.

#### Scenario: An unsupported global flag is rejected
- **WHEN** the user runs `pipeline merge 42` with any explicitly-provided option other than `--repo-path`, `--base`, or `--profile` (for example `--detach`, `--json`, `--is-ok`, `--timeout 60`, `--no-edit`, or `--domain d`)
- **THEN** the command SHALL exit with code 2 and an error naming the offending flag and stating that `pipeline merge` does not support it, and SHALL NOT inspect, gate, or merge the PR

#### Scenario: Allowlisted flags are accepted
- **WHEN** the user runs `pipeline merge 42 --base main`, `pipeline merge 42 --profile claude`, or `pipeline merge 42 --repo-path <path>`
- **THEN** the allowlist guard SHALL NOT reject the invocation and the command SHALL proceed to PR-number validation and the merge gates

#### Scenario: New global options cannot leak by default
- **WHEN** a new global CLI option is added to the pipeline and is not added to the merge allowlist
- **THEN** providing that option to `pipeline merge` SHALL be rejected with exit code 2 without any code change to the merge guard

---

### Requirement: The `merge` sub-command SHALL verify PR mergeability before merging
The merge handler SHALL call `gh pr view <pr> --json mergeable,mergeStateStatus` and inspect the result before proceeding. It SHALL refuse to merge and exit non-zero with an actionable message if the PR is not `MERGEABLE` or its `mergeStateStatus` is not `CLEAN`.

#### Scenario: Mergeable clean PR proceeds to next gate
- **WHEN** `gh pr view` returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`
- **THEN** the handler proceeds to the checks gate and does not exit

#### Scenario: Conflicted PR is refused
- **WHEN** `gh pr view` returns `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"`
- **THEN** the handler SHALL exit non-zero with a message identifying the conflict condition and SHALL NOT merge

#### Scenario: Unknown mergeability state is refused
- **WHEN** `gh pr view` returns `mergeable: "UNKNOWN"` (GitHub has not yet computed it)
- **THEN** the handler SHALL exit non-zero advising the user to wait and retry

---

### Requirement: The `merge` sub-command SHALL verify required status checks before merging
After confirming mergeability, the handler SHALL call `gh pr checks <pr> --required --json name,bucket` to obtain only the checks that branch protection marks as required, and SHALL refuse to merge if any required check has not passed. Optional checks (pending, skipped, or failed) are not returned by `--required` and SHALL NOT block the merge. The `bucket` field categorises each check as `pass`, `fail`, `pending`, `skipping`, or `cancel`; only `pass` and `skipping` are non-blocking.

#### Scenario: All required checks passing
- **WHEN** all required checks have bucket `pass` or `skipping`
- **THEN** the handler proceeds to the issue-stage gate

#### Scenario: Any required check failing or pending
- **WHEN** any required check has bucket `fail`, `pending`, or `cancel`
- **THEN** the handler SHALL exit non-zero with a message naming the failing or pending check(s) and SHALL NOT merge

#### Scenario: Optional checks do not block
- **WHEN** `gh pr checks --required` returns only passing required checks but optional checks have other states
- **THEN** the handler SHALL proceed to the issue-stage gate and SHALL NOT block on optional check states

---

### Requirement: The `merge` sub-command SHALL verify the linked issue is at `pipeline:ready-to-deploy`
After confirming checks pass, the handler SHALL resolve the GitHub issue linked to the PR via `getPrForIssue` (the `pr-resolution` authoritative resolver) and confirm that the issue carries the label `pipeline:ready-to-deploy`. If no linked issue is found or the issue is at any other stage, the handler SHALL refuse.

#### Scenario: Linked issue is at ready-to-deploy
- **WHEN** the resolved linked issue carries the label `pipeline:ready-to-deploy`
- **THEN** the handler proceeds to execute the squash merge

#### Scenario: Linked issue is at a stage before ready-to-deploy
- **WHEN** the resolved linked issue carries a `pipeline:*` label that is not `pipeline:ready-to-deploy`
- **THEN** the handler SHALL exit non-zero naming the current stage and advising the user to let the pipeline advance first

#### Scenario: No linked issue found
- **WHEN** `getPrForIssue` returns null for the PR's associated issue
- **THEN** the handler SHALL exit non-zero explaining that no linked pipeline issue was found and SHALL NOT merge

---

### Requirement: The `merge` sub-command SHALL squash-merge and delete the branch on success
When all gates pass, the handler SHALL invoke `gh pr merge <pr> --squash --delete-branch --match-head-commit <headRefOid>` where `headRefOid` is the PR head commit SHA fetched in the same `gh pr view` call used for the mergeability gate. The `--match-head-commit` flag binds the merge to the inspected head SHA and causes `gh` to abort if a new commit was pushed between gate inspection and merge execution, closing the TOCTOU race. The handler SHALL print a confirmation message on success and exit 0.

#### Scenario: Successful squash merge
- **WHEN** all three gates pass (mergeable, checks, issue stage)
- **THEN** the handler invokes `gh pr merge <pr> --squash --delete-branch --match-head-commit <headRefOid>`
- **AND** prints a confirmation message including the PR number
- **AND** exits 0

#### Scenario: Head SHA is absent — merge is aborted
- **WHEN** `gh pr view` returns an empty or missing `headRefOid`
- **THEN** the handler SHALL exit non-zero with an error explaining that the head commit SHA could not be determined and SHALL NOT invoke `gh pr merge`

#### Scenario: Branch already deleted is treated as a non-fatal warning
- **WHEN** `gh pr merge --delete-branch` reports that the head branch was already deleted (stderr contains "already deleted" or "branch not found")
- **THEN** the handler SHALL NOT exit non-zero for this condition and SHALL continue to print the success confirmation

#### Scenario: Merge API error is surfaced
- **WHEN** `gh pr merge` exits non-zero for any reason other than branch already deleted
- **THEN** the handler SHALL exit non-zero with the `gh` error output surfaced to the user

---

### Requirement: The `merge` sub-command logic SHALL be behind a `MergeDeps` dependency-injection seam
All I/O (calls to `gh pr view`, `gh pr checks --required`, `gh pr merge`, and issue-label inspection) SHALL be injected via a `MergeDeps` interface parameter. The real production deps call `gh`; test deps return fixtures. Unit tests SHALL NOT make any real network, git, or subprocess call.

#### Scenario: Unit test uses fake deps
- **WHEN** a unit test constructs a `MergeDeps` with stubbed `ghPrView`, `ghPrChecksRequired`, `ghPrMerge`, and `getIssueLabels` implementations
- **THEN** running `mergePr(prNumber, deps)` exercises the gate logic without any real `gh` subprocess

#### Scenario: Production code uses real deps
- **WHEN** the `pipeline merge` CLI dispatches the handler in production
- **THEN** it passes `realMergeDeps()` which shells out to `gh` for all I/O

---

### Requirement: The autonomous `advance` loop SHALL never invoke the merge handler
The `merge` handler SHALL NOT be called from any stage handler, the advance loop, or any path reachable from `pipeline advance`. A unit test SHALL assert this loop-isolation guarantee.

#### Scenario: No stage transition calls merge
- **WHEN** the advance loop dispatches any stage (planning, review-1, fix-1, review-2, fix-2, pre-merge, eval-gate, shipcheck-gate, deploy-ready)
- **THEN** no call to the `mergePr` function or `merge.ts` exports occurs

#### Scenario: Test asserts the loop-isolation guarantee
- **WHEN** the loop-isolation unit test runs
- **THEN** it imports all stage handlers and the advance loop and asserts that none of them import or reference any symbol from `merge.ts`

