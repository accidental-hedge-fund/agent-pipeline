# merge-sub-command Specification

## Purpose
TBD - created by archiving change pipeline-merge-pr-human-invoked. Update Purpose after archive.

## Requirements

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

The merge handler SHALL read PR mergeability via `gh pr view <pr>` (or the
injected `ghPrView` seam) including at least `mergeable`, `mergeStateStatus`,
and `headRefOid` before proceeding to later gates or the squash merge.

When the latest read reports `mergeable: "UNKNOWN"` (GitHub has not yet
computed mergeability), the handler SHALL **not** treat that as a terminal
refusal on the first observation. It SHALL re-read under a bounded budget
defined by named constants:

- `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS = 5` total mergeability reads (the initial
  read **counts** toward the budget);
- `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS = 5000` fixed delay between consecutive
  UNKNOWN reads (at most 4 sleeps for a full budget).

The delay SHALL be injectable for tests so unit tests do not wall-clock wait.

The handler SHALL sleep and re-read **only** when `mergeable === "UNKNOWN"`.
Any other non-success classification (`CONFLICTING`, `DIRTY`, `BEHIND`,
`BLOCKED`, `HAS_HOOKS`, `MERGEABLE` with non-`CLEAN` status, or any other
non-`MERGEABLE`/`CLEAN` combination that is not the pure UNKNOWN compute gap)
SHALL refuse immediately on that read with **zero** sleep and without further
UNKNOWN-budget consumption.

The handler SHALL proceed to the checks gate only when a successful read reports
`mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`. The head SHA used for
`--match-head-commit` SHALL come from the same successful MERGEABLE+CLEAN read
that passed the mergeability gate — never from an earlier UNKNOWN read.

The handler SHALL refuse to merge and exit non-zero (or throw to the caller)
with an actionable message when:

- after the retry budget is exhausted, mergeability is still `UNKNOWN`; or
- any read reports a hard unclean state as above.

The handler SHALL **never** treat `UNKNOWN` as `MERGEABLE` and SHALL **not**
invoke the squash merge while the latest successful mergeability classification
in the attempt loop is still UNKNOWN.

#### Scenario: Mergeable clean PR proceeds to next gate

- **WHEN** `gh pr view` returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"`
- **THEN** the handler proceeds to the checks gate and does not exit

#### Scenario: Conflicted PR is refused

- **WHEN** `gh pr view` returns `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"`
- **THEN** the handler SHALL exit non-zero with a message identifying the conflict condition and SHALL NOT merge
- **AND** the handler SHALL NOT burn the UNKNOWN retry budget as a path to a successful merge for that observation

#### Scenario: Transient UNKNOWN then MERGEABLE succeeds within budget

- **WHEN** the first mergeability read returns `mergeable: "UNKNOWN"`
- **AND** the second read within the budget returns `mergeable: "MERGEABLE"` and `mergeStateStatus: "CLEAN"` with a distinct `headRefOid`
- **THEN** the handler SHALL proceed to the checks gate (and subsequent gates) using the head SHA from the **second** (successful) read
- **AND** it SHALL NOT exit non-zero solely because the first read was UNKNOWN
- **AND** a unit test with injected deps and fake sleep SHALL assert exactly two mergeability reads, one sleep of `MERGEABILITY_UNKNOWN_RETRY_DELAY_MS`, and one merge using the second head SHA

#### Scenario: Unknown mergeability state is refused

- **WHEN** every mergeability read within the bounded attempt budget returns `mergeable: "UNKNOWN"` (GitHub never computes a definite state in budget)
- **THEN** the handler SHALL perform exactly `MERGEABILITY_UNKNOWN_MAX_ATTEMPTS` mergeability reads and `MAX_ATTEMPTS - 1` sleeps
- **AND** the handler SHALL exit non-zero (or throw) with an actionable message that mergeability is still UNKNOWN / not yet computed and advising wait/retry
- **AND** the handler SHALL NOT invoke `gh pr merge`

#### Scenario: UNKNOWN is never treated as MERGEABLE

- **WHEN** the latest mergeability classification for the current attempt is `UNKNOWN`
- **THEN** the handler SHALL NOT invoke the squash merge on that attempt
- **AND** it SHALL only squash after a later read reports `MERGEABLE` and `CLEAN` (or fail closed after budget exhaustion)

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

### Requirement: Per-PR `merge` remains the sole merge primitive while merge-queue is dry-run only
The existing human-invoked `pipeline merge <pr>` sub-command SHALL remain the
only code path that performs a squash merge for a ready-to-deploy PR in this
change. The merge-queue dry-run surface SHALL NOT call `mergePr` or otherwise
bypass the merge sub-command’s mergeability, required-check, and R2D gates.
A future sequential-drive change MAY invoke the merge primitive once per ordered
candidate under explicit operator drive, without relaxing those gates.

#### Scenario: Dry-run merge-queue does not squash-merge
- **WHEN** `pipeline merge-queue --milestone <m>` runs in dry-run mode against
  one or more merge candidates
- **THEN** `gh pr merge` / `mergePr` SHALL NOT be invoked for any candidate

#### Scenario: Operator still merges a single PR via merge
- **WHEN** the operator runs `pipeline merge 42` on a PR that passes merge gates
- **THEN** the existing merge sub-command behavior SHALL apply unchanged by this
  change’s dry-run queue surface

### Requirement: The `merge` sub-command is an operator-authorized CLI surface

The Pipeline CLI SHALL accept `merge` as a positional sub-command keyword that takes one pull-request number and that is never invoked by the autonomous `advance` loop. It SHALL be dispatched when the first positional argument is the string `merge` (case-sensitive). The command is an explicit operator-authorized surface: the operator MAY invoke it directly, and an external supervisor MAY invoke it under operator authority. All of its existing merge gates SHALL remain in effect for every caller.

#### Scenario: Invoked directly by an operator with a PR number

- **WHEN** the operator runs `pipeline merge 42`
- **THEN** the command dispatches the merge handler with pull-request number 42 and does not advance any Pipeline stage label

#### Scenario: Invoked by a scoped operator delegate

- **WHEN** an external supervisor under operator authority invokes `pipeline merge 42` for a ready-to-deploy issue
- **THEN** the command SHALL apply the same mergeability, check, issue-stage, and exact-head gates as a direct operator invocation
- **AND** the advance loop SHALL remain uninvolved

#### Scenario: Missing PR number exits with a usage error

- **WHEN** the user runs `pipeline merge` with no pull-request number
- **THEN** the command SHALL exit non-zero with a usage error that states that a pull-request number is required

#### Scenario: Non-numeric argument is rejected

- **WHEN** the user runs `pipeline merge foo` where `foo` is not a positive integer
- **THEN** the command SHALL exit non-zero with an error that states that a numeric pull-request number is required

### Requirement: Mergeability UNKNOWN retry SHALL use injectable delay

The merge handler’s UNKNOWN re-read loop SHALL wait between attempts via an
injected sleep/delay seam on the merge dependency interface (or an equivalent
test-injectable delay passed into `mergePr`). Production deps MAY use a real
timer. Unit tests SHALL supply a fake delay that records calls without
wall-clock waiting. The attempt budget and delay constants SHALL be deterministic
and named so tests can pin attempt counts.

#### Scenario: Unit test controls retry timing

- **WHEN** a unit test injects a fake sleep and a sequence of UNKNOWN then MERGEABLE+CLEAN mergeability reads
- **THEN** the handler SHALL call the fake sleep between UNKNOWN attempts
- **AND** SHALL complete successfully without real `setTimeout` wall-clock delay
- **AND** SHALL NOT make real network, git, or subprocess calls

### Requirement: The merge sub-command SHALL act as an operation adapter under RecoverySupervisor

`pipeline merge` SHALL perform one bounded merge attempt and report a typed operation observation with side-effect certainty. It SHALL NOT choose lifecycle treatment or declare the Logical Operation terminal on mechanical failure, timeout, or uncertain merge response. The existing mergeability, required-check, linked-issue, and `--match-head-commit` gates SHALL remain the exact-candidate gates. The operator CLI MAY still exit non-zero for operator UX. Supervised callers (train merge wave and merge-queue apply) SHALL keep the operation owned.

#### Scenario: Adapter does not declare terminal on uncertain merge

- **WHEN** `gh pr merge` times out or returns output that does not prove success or absence
- **THEN** the merge adapter SHALL report side-effect certainty uncertain
- **AND** it SHALL NOT mark the Logical Operation complete, cancelled, or human-owned

#### Scenario: Operator CLI exit does not become ownerless for supervised callers

- **WHEN** train or merge-queue apply receives a non-zero merge observation
- **THEN** RecoverySupervisor SHALL retain ownership
- **AND** the caller SHALL reconcile remote PR state before any replay

---

### Requirement: The merge sub-command SHALL persist an exact-candidate claim and reconcile before retry

Before invoking `gh pr merge`, the merge adapter SHALL persist a claim that binds repository, base, frozen issue scope, PR, inspected head SHA, and action identity, using the head SHA from the successful MERGEABLE+CLEAN read. After timeout, crash, or uncertain response, the adapter SHALL observe live PR merge state and prove base containment before any replay. A zero exit from `gh pr merge` SHALL NOT complete the operation until that observer proves the PR is merged and the merge-result is contained in the fetched base. A moved head SHALL invalidate the claim and derived merge authorization.

#### Scenario: Claim uses the inspected MERGEABLE head

- **WHEN** mergeability reads UNKNOWN then MERGEABLE+CLEAN with head SHA H
- **THEN** the claim SHALL bind H
- **AND** `--match-head-commit` SHALL use H
- **AND** the adapter SHALL NOT bind an earlier UNKNOWN head

#### Scenario: Restart after uncertain merge observes GitHub

- **WHEN** the process dies after `gh pr merge` is submitted
- **AND** a later invoke observes the PR merged with merge-result contained in the fetched base
- **THEN** the adapter SHALL complete without a second merge mutation

#### Scenario: Zero-exit merge waits until containment is proven

- **WHEN** `gh pr merge` returns zero
- **AND** the observer has not yet proven the PR merged and contained in the fetched base
- **THEN** the adapter SHALL NOT persist `outcome: "complete"`
- **AND** it SHALL keep the claim owned as submitted or uncertain

#### Scenario: Moved head refuses the stale claim

- **WHEN** reconciliation shows a head SHA different from the claimed inspected head
- **THEN** the adapter SHALL NOT submit merge under the stale claim
- **AND** derived merge authorization SHALL be invalid until a new gate pass

#### Scenario: Claim acquire is exclusive before mutation

- **WHEN** two merge adapters race to persist the exact-candidate claim for the same PR
- **THEN** only the compare-and-swap winner SHALL call `gh pr merge`
- **AND** the loser SHALL reconcile or wait without a second mutation

#### Scenario: Frozen scope must match the live closing issue

- **WHEN** merge-queue apply or train supplies frozen issue scope A
- **AND** the PR's current closing issue is B
- **THEN** merge SHALL refuse before submission
- **AND** it SHALL re-check that linkage in the final pre-submit read

#### Scenario: Live PR base must match the configured base

- **WHEN** a fresh candidate read returns `baseRefName` different from the configured base on the claim
- **THEN** merge SHALL NOT invoke `gh pr merge`
- **AND** it SHALL re-check `baseRefName` in the final pre-submit read

#### Scenario: Uncertain cooling starts at the uncertain transition

- **WHEN** `gh pr merge` times out after the claim has been `submitted`
- **THEN** the claim SHALL record a transition timestamp for `uncertain`
- **AND** the next invoke SHALL cool from that timestamp rather than `started_at`
