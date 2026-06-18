## ADDED Requirements

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
After confirming mergeability, the handler SHALL inspect `statusCheckRollup` from `gh pr view` and refuse to merge if any required status check has not concluded in a success state.

#### Scenario: All required checks passing
- **WHEN** all required status check conclusions are SUCCESS or NEUTRAL
- **THEN** the handler proceeds to the issue-stage gate

#### Scenario: Any required check failing or pending
- **WHEN** any required status check has a conclusion of FAILURE, TIMED_OUT, CANCELLED, or is still in progress
- **THEN** the handler SHALL exit non-zero with a message naming the failing or pending check(s) and SHALL NOT merge

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
When all gates pass, the handler SHALL invoke `gh pr merge <pr> --squash --delete-branch` to squash-merge the PR and remove the head branch. It SHALL print the merge URL on success and exit 0.

#### Scenario: Successful squash merge
- **WHEN** all three gates pass (mergeable, checks, issue stage)
- **THEN** the handler invokes `gh pr merge <pr> --squash --delete-branch`
- **AND** prints a confirmation message including the PR number and merged commit reference
- **AND** exits 0

#### Scenario: Branch already deleted is treated as a non-fatal warning
- **WHEN** `gh pr merge --delete-branch` reports that the head branch was already deleted
- **THEN** the handler SHALL NOT exit non-zero for this condition and SHALL continue to print the success confirmation

#### Scenario: Merge API error is surfaced
- **WHEN** `gh pr merge` exits non-zero for any reason other than branch already deleted
- **THEN** the handler SHALL exit non-zero with the `gh` error output surfaced to the user

---

### Requirement: The `merge` sub-command logic SHALL be behind a `MergeDeps` dependency-injection seam
All I/O (calls to `gh pr view`, `gh pr merge`, and issue-label inspection) SHALL be injected via a `MergeDeps` interface parameter. The real production deps call `gh`; test deps return fixtures. Unit tests SHALL NOT make any real network, git, or subprocess call.

#### Scenario: Unit test uses fake deps
- **WHEN** a unit test constructs a `MergeDeps` with stubbed `ghPrView`, `ghPrMerge`, and `getIssueLabels` implementations
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
