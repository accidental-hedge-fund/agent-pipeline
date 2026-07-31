# merge-queue-drive Specification

## Purpose
Operator-invoked sequential drive of an ordered ready-to-deploy candidate set through the existing `mergePr` surface, with revalidation, single-flight merges, fail-stop on hard failure, and explicit apply/confirm required.

## Requirements

### Requirement: Merge-queue drive SHALL process at most one merge at a time
The merge-queue drive mode SHALL walk an ordered candidate list strictly sequentially: for each candidate it SHALL complete revalidation and any merge attempt (success or failure) before starting the next candidate. The drive SHALL NOT start two concurrent merges against the same repository base branch.

#### Scenario: Two eligible candidates merge in order without overlap
- **WHEN** drive runs with `--apply` over an ordered list of two eligible open PRs `#10` then `#11`
- **THEN** the drive SHALL invoke the merge handler for `#10` and wait until that invocation settles
- **AND** only then SHALL it invoke the merge handler for `#11`
- **AND** unit tests with injected deps SHALL prove that the second merge is not started before the first merge promise settles

#### Scenario: Parallel merge pool is forbidden
- **WHEN** drive is implemented or invoked
- **THEN** it SHALL NOT schedule multiple in-flight `mergePr` (or equivalent) calls via a worker pool or concurrent fan-out for the same apply run

---

### Requirement: Merge-queue drive SHALL merge only through the existing human merge surface
Each merge performed by drive mode SHALL call the existing exported merge handler used by `pipeline merge` / `/pipeline:merge` (`mergePr` with `MergeDeps` or a thin wrapper that only adds queue-level logging around that call). Drive SHALL NOT introduce a separate unguarded `gh pr merge` path with different flags, weaker gates, or a divergent squash/delete-branch policy.

#### Scenario: Successful candidate uses mergePr
- **WHEN** drive elects to merge PR `#42` during an apply run
- **THEN** it SHALL call `mergePr(42, deps)` (or the documented thin wrapper)
- **AND** SHALL NOT shell a second merge implementation that bypasses `mergePr` gates

#### Scenario: mergePr policy remains authoritative
- **WHEN** `mergePr` refuses a PR for mergeability, required checks, or linked-issue stage
- **THEN** drive SHALL treat that refusal as a hard failure for the item and SHALL NOT attempt an alternate merge API to force the merge

---

### Requirement: Merge-queue drive SHALL require an explicit apply or confirm flag
Drive mode SHALL perform zero merges, branch deletions, or other irreversible GitHub mutations unless the operator passes an explicit apply/confirm flag (canonical name `--apply`, or the equivalent flag name defined by the parent merge-queue command surface). Dry-run / selection-only invocation remains the default and SHALL not activate drive merges.

#### Scenario: Without apply flag no merges occur
- **WHEN** the operator runs the merge-queue command without `--apply` (or equivalent confirm flag)
- **THEN** the drive merge path SHALL NOT be entered
- **AND** zero calls to `mergePr` SHALL occur for that invocation

#### Scenario: With apply flag drive may merge
- **WHEN** the operator runs the merge-queue command with `--apply` and a non-empty ordered candidate set
- **THEN** the drive path MAY call `mergePr` for eligible candidates according to the sequential rules in this capability
- **AND** the operator invoking `--apply` is the merge authority for that process session only

#### Scenario: No auto_merge config enables drive
- **WHEN** repository configuration is loaded
- **THEN** no `auto_merge` (or equivalent) config key SHALL turn on drive merges without the operator's explicit apply/confirm flag on the invocation

---

### Requirement: Merge-queue drive SHALL re-validate each candidate before merging
Immediately before attempting to merge a candidate, drive SHALL re-check that the PR is still a valid merge candidate for this queue. At minimum the revalidation SHALL establish that the PR is still open (or classify already-done), still linked to a `pipeline:ready-to-deploy` issue (or equivalent policy labels required by the selection contract), and still mergeable with required checks in a passing state — either by explicit pre-checks or by relying on `mergePr` gates while still recording queue-level outcomes. When revalidation finds a hard ineligibility reason other than already-done, drive SHALL **stop** the run without attempting later candidates.

#### Scenario: Candidate still eligible proceeds to merge
- **WHEN** revalidation for the next ordered candidate reports open, R2D-linked, mergeable/CLEAN, and checks green (or `mergePr` would accept)
- **THEN** drive SHALL attempt `mergePr` for that PR

#### Scenario: Candidate lost eligibility — fail-stop
- **WHEN** revalidation finds the PR open but not mergeable, checks not green, or the linked issue no longer at `pipeline:ready-to-deploy`
- **THEN** drive SHALL record a clear reason for that item
- **AND** SHALL NOT call `mergePr` for that item if pre-checks already proved hard failure (or SHALL surface `mergePr`'s refusal as the reason)
- **AND** SHALL NOT attempt subsequent candidates in the ordered list

#### Scenario: Candidate already merged or closed — skip and continue
- **WHEN** revalidation finds the PR already merged or closed
- **THEN** drive SHALL record the item as skipped already-done
- **AND** SHALL continue to the next candidate without treating the run as a hard failure solely for that skip

---

### Requirement: Merge-queue drive SHALL fail-stop on merge failure and proceed after success
On successful `mergePr`, drive SHALL proceed to the next candidate in order. On `mergePr` failure (conflict, required check fail, merge API error, or other thrown refusal), drive SHALL stop the run, leave remaining candidates unattempted, and report outcomes for merged, skipped, failed, and not-attempted items. The default policy is fail-stop, not hold-and-continue.

#### Scenario: Success advances to next candidate
- **WHEN** `mergePr` completes successfully for candidate i
- **THEN** drive SHALL proceed to revalidate candidate i+1 (if any)

#### Scenario: mergePr throws — stop remaining
- **WHEN** `mergePr` throws for candidate i (conflict, checks, API error, or gate refusal)
- **THEN** drive SHALL record candidate i as failed with the error reason
- **AND** SHALL mark all later candidates as not-attempted
- **AND** SHALL exit the apply run with a non-zero status
- **AND** SHALL NOT call `mergePr` for any later candidate in that run

#### Scenario: Outcome summary is emitted
- **WHEN** an apply run finishes (full success, fail-stop, or all remaining skipped already-done)
- **THEN** drive SHALL emit a summary that lists each candidate's outcome and reason where applicable so the operator can see what merged and where the queue stopped

---

### Requirement: Merge-queue drive SHALL remain isolated from the advance loop
The autonomous `advance` loop, stage handlers, and any path reachable from `pipeline advance` SHALL NOT invoke merge-queue drive or call `mergePr` on its behalf. Drive is a human-invoked, apply-gated surface only.

#### Scenario: Advance stages never call drive
- **WHEN** the advance loop dispatches any stage (planning through deploy-ready)
- **THEN** no call to the merge-queue drive entry point occurs
- **AND** no call to `mergePr` is made by the advance loop

#### Scenario: Unit test guards isolation
- **WHEN** the loop-isolation tests for merge surfaces run
- **THEN** they SHALL assert that advance/dispatch paths do not import or invoke the drive entry point for merging

---

### Requirement: Merge-queue drive logic SHALL be testable via injected dependencies
All I/O used by drive (candidate revalidation, `mergePr` / merge deps, logging) SHALL be injectable via a deps seam. Unit tests SHALL prove ordering, single-flight behavior, apply gating, already-done skip, and fail-stop without real network, git, or subprocess calls.

#### Scenario: Unit test fakes merge and revalidation
- **WHEN** a unit test constructs drive deps with stubbed revalidation and a stub `mergePr`
- **THEN** running drive over a fixture candidate list exercises order and stop policy with no real `gh` subprocess

#### Scenario: Apply gating is unit-tested
- **WHEN** a unit test invokes the merge-queue entry without the apply/confirm flag
- **THEN** the test asserts zero merge calls
- **AND** when the same entry is invoked with apply over two candidates, the test asserts sequential merge calls in list order
