# merge-queue-repair-hold Specification

## Purpose
TBD - created by archiving change merge-queue-surgical-conflict-ci-repair. Update Purpose after archive.
## Requirements
### Requirement: Merge-queue hold reasons SHALL include merge-conflict and checks-failed

The merge-queue drive SHALL define a closed set of hold reason keys that includes at least
`merge-conflict` and `checks-failed`. Each recorded hold SHALL carry the reason key and
operator-visible remediation text that names the PR (and linked issue when known) and states
concrete next steps (manual conflict resolution or repair, wait/fix required checks, then
re-run drive or `pipeline merge`). Hold reason keys SHALL be stable machine-readable strings
suitable for unit assertions and run artifacts.

#### Scenario: Conflict produces merge-conflict hold with remediation

- **WHEN** drive eligibility observes a candidate PR that is non-mergeable due to merge
  conflicts (`mergeable` not `MERGEABLE` and/or `mergeStateStatus` indicating a dirty/conflicted
  state as used by the drive's mergeability check)
- **THEN** the drive SHALL record a hold with reason key `merge-conflict`
- **AND** the operator-visible remediation text SHALL identify the PR and direct conflict
  resolution before merge

#### Scenario: Red or incomplete required checks produce checks-failed hold with remediation

- **WHEN** drive eligibility observes that one or more required checks for the PR head are
  in a blocking bucket (`fail`, `pending`, or `cancel`)
- **THEN** the drive SHALL record a hold with reason key `checks-failed`
- **AND** the operator-visible remediation text SHALL identify the PR and name or summarize
  the blocking required check(s) when available

#### Scenario: Hold reason keys are stable for tests and artifacts

- **WHEN** a hold is recorded for conflict or required-check failure
- **THEN** the reason key SHALL be exactly `merge-conflict` or `checks-failed` respectively
- **AND** a unit test SHALL be able to assert the key without parsing freeform prose

---

### Requirement: Apply mode SHALL feed planning-time conflict and check failures through the drive hold path

Apply-mode merge-queue SHALL include selected ready-to-deploy PRs that planning classified
as skips for `non-mergeable` or `checks-not-green` reasons in the ordered drive candidate
set (in addition to plan merge candidates), so drive eligibility can record stable holds
and, when repair is enabled, attempt surgical repair and re-gate. Permanent hard planning
skips (`missing-pr`, `wrong-base`, `empty-head-sha`) SHALL remain plan-only and SHALL NOT
be promoted into the drive list. Dry-run mode SHALL continue to present conflict/check
failures only as plan skips and SHALL NOT record holds or invoke repair.

#### Scenario: Planning-time conflicted PR is held under apply

- **WHEN** planning classifies an R2D-linked PR as a `non-mergeable` skip and the operator
  runs merge-queue with `--apply`
- **THEN** the drive SHALL still evaluate that PR
- **AND** SHALL record a `merge-conflict` hold when eligibility remains conflicted
- **AND** SHALL NOT silently omit the PR solely because planning skipped it

#### Scenario: Planning-time checks-not-green PR can enter repair under apply --repair

- **WHEN** planning classifies an R2D-linked PR as a `checks-not-green` skip and the
  operator runs merge-queue with `--apply --repair` (and repair budget remains)
- **THEN** the drive SHALL still evaluate that PR
- **AND** MAY invoke the optional surgical repair path for a `checks-failed` hold
- **AND** SHALL re-gate before any merge

#### Scenario: Dry-run keeps conflict/check failures as plan skips only

- **WHEN** the operator runs merge-queue without `--apply` against a conflicted or red-check
  R2D PR
- **THEN** the handler SHALL report the item in the plan skip set
- **AND** SHALL NOT record a drive hold or invoke repair

---

### Requirement: Conflict or red required checks SHALL hold the item and SHALL NOT force-merge

The merge-queue drive SHALL record a per-item hold and SHALL NOT invoke the merge surface
when it encounters `merge-conflict` or `checks-failed` for a candidate while the hold
condition remains true, and SHALL NOT bypass mergeability or required-check gates. The
default drive policy SHALL be **hold the item and continue** with remaining ordered
candidates that are still eligible. The drive SHALL NOT introduce an `auto_merge` config key
and SHALL NOT merge from the autonomous advance loop.

#### Scenario: Conflicted PR is held and not merged

- **WHEN** a candidate is conflicted during drive
- **THEN** the drive SHALL record a `merge-conflict` hold for that item
- **AND** SHALL NOT call `mergePr` / the merge handler for that PR while conflicted

#### Scenario: Red required checks are held and not merged

- **WHEN** a candidate has one or more blocking required checks during drive
- **THEN** the drive SHALL record a `checks-failed` hold for that item
- **AND** SHALL NOT call `mergePr` / the merge handler for that PR while required checks
  remain blocking

#### Scenario: Default policy continues remaining candidates after a hold

- **WHEN** one candidate is held for `merge-conflict` or `checks-failed` and one or more
  later candidates remain in the ordered list
- **THEN** the drive SHALL continue evaluating the remaining candidates under the default
  hold-and-continue policy
- **AND** SHALL NOT abort the entire batch solely because one item was held

#### Scenario: No force-merge path exists for held items

- **WHEN** an item is held for conflict or checks failure
- **THEN** no code path in the merge-queue drive SHALL squash-merge that PR without first
  clearing the hold condition via re-validated eligibility

---

### Requirement: Optional surgical repair path SHALL fix conflict or CI only in the managed worktree

The merge-queue drive SHALL support an optional repair path that, when enabled by
configuration or an explicit drive flag, resolves the candidate PR's managed worktree and
invokes a fix/implementer harness to attempt resolution of the hold cause. The repair
invocation SHALL instruct **surgical-fix discipline**: the minimal diff that addresses the
merge conflict and/or the failing required checks only; it SHALL forbid refactors,
scope-broadening, unrelated changes, and opportunistic cleanup. Destructive or irreversible
operations SHALL be constrained to the managed worktree root and/or the reviewed head
consistent with surgical-fix guards. When repair is not enabled, the drive SHALL only
record the hold and remediation without invoking a harness.

#### Scenario: Repair disabled records hold without harness

- **WHEN** drive observes a conflict or checks failure and repair is not enabled
- **THEN** the drive SHALL record the appropriate hold
- **AND** SHALL NOT invoke a fix/implementer harness for that item

#### Scenario: Repair enabled uses managed worktree and surgical discipline

- **WHEN** repair is enabled and drive elects to repair a held `merge-conflict` or
  `checks-failed` item
- **THEN** the drive SHALL resolve the PR's managed worktree (not an unmanaged ad-hoc path)
- **AND** SHALL invoke the fix/implementer with instructions requiring a minimal
  conflict/CI-only diff and forbidding unrelated feature work

#### Scenario: Repair prompt forbids broad feature work

- **WHEN** the repair harness prompt is constructed for a merge-queue hold
- **THEN** the prompt text SHALL constrain the change to resolving the conflict and/or
  required-check failures
- **AND** SHALL explicitly forbid refactors, scope-broadening, and opportunistic cleanup

#### Scenario: Repair infrastructure failure records a hold and continues

- **WHEN** repair is enabled and resolving the managed worktree or invoking the repair
  harness throws / rejects (infrastructure failure)
- **THEN** the drive SHALL record a held outcome for that item with the current hold reason
  and evidence including the infrastructure error and attempt count
- **AND** SHALL NOT call `mergePr` for that item while the hold remains
- **AND** SHALL continue evaluating later candidates under the default hold-and-continue policy
- **AND** SHALL NOT exit the drive run solely because of the uncaught repair exception

---

### Requirement: Post-repair merge retry SHALL re-run eligibility gates via the existing merge surface

The merge-queue drive SHALL re-evaluate the same eligibility gates used before merge after
a repair attempt pushes one or more commits to the PR head (at minimum: PR still open,
linked issue still satisfies ready-to-deploy / selection policy, mergeable clean state,
required checks non-blocking, and — when a queue base branch is configured — `baseRefName`
still matching that expected base). Only when those gates pass SHALL the drive retry merge, and
the retry SHALL go through the existing merge surface used by `pipeline merge` / `mergePr`.
The drive SHALL NOT merge a PR that fails re-gate, including when a repair just completed.
A base-branch mismatch is non-repairable: the drive SHALL NOT call `mergePr` and SHALL NOT
treat the mismatch as a surgical-repair hold.

#### Scenario: Successful repair becomes re-eligible then merges through mergePr

- **WHEN** a repair push completes and re-evaluation shows the PR open, policy-eligible,
  mergeable, and required checks non-blocking
- **THEN** the drive MAY clear the hold for that item and invoke the existing merge surface
- **AND** SHALL NOT use a separate unguarded `gh pr merge` path that skips those gates

#### Scenario: Repair that leaves checks red does not merge

- **WHEN** a repair push completes but required checks remain blocking
- **THEN** the drive SHALL keep or re-record a `checks-failed` hold
- **AND** SHALL NOT invoke the merge surface for that PR

#### Scenario: Repair that leaves conflicts does not merge

- **WHEN** a repair attempt completes but the PR remains conflicted
- **THEN** the drive SHALL keep or re-record a `merge-conflict` hold
- **AND** SHALL NOT invoke the merge surface for that PR

#### Scenario: Re-gate uses the same eligibility contract as pre-merge attempt

- **WHEN** the drive re-evaluates a previously held item after repair
- **THEN** the eligibility checks SHALL be the same contract used for non-repair candidates
  before merge (open, policy/R2D, mergeability, required checks, and configured base when set)
- **AND** SHALL NOT skip any of those checks because a repair was attempted

#### Scenario: Retargeted base fails re-gate without merge

- **WHEN** eligibility evaluation (pre-merge or post-repair) finds a configured expected base
  and the PR's `baseRefName` does not match
- **THEN** the drive SHALL treat the item as non-repairable ineligible / failed
- **AND** SHALL NOT call `mergePr` for that PR
- **AND** SHALL NOT invoke surgical repair solely to "fix" the wrong base

---

### Requirement: Repair budget SHALL be bounded and exhaustion leaves a human hold with evidence

The optional repair path SHALL enforce a finite per-item budget of at least a maximum
repair attempt count, and MAY also enforce a maximum wall-clock duration for repair-related
waiting. When the budget is exhausted without the item becoming eligible, the drive SHALL
leave the item held for a human, SHALL stop further automatic repair for that item within
the current drive session, and SHALL retain operator-visible evidence including hold reason,
attempt count, and a summary of conflict or check state (and head SHA when known).

#### Scenario: Budget exhaustion leaves hold with evidence

- **WHEN** repair has been attempted up to the configured maximum attempts for an item
  without restoring eligibility
- **THEN** the drive SHALL leave the item held with the appropriate hold reason
- **AND** SHALL NOT start another automatic repair attempt for that item in the same drive
  session
- **AND** the hold evidence SHALL include attempt count and a conflict or checks summary

#### Scenario: Successful repair within budget proceeds to re-gate

- **WHEN** a repair succeeds within the attempt budget and re-gate passes
- **THEN** the drive MAY proceed to merge via the existing merge surface
- **AND** SHALL count the successful path within the budget accounting for that item

#### Scenario: Zero or exhausted budget never auto-repairs

- **WHEN** the configured maximum repair attempts is zero, or the item's remaining budget is
  already exhausted
- **THEN** the drive SHALL NOT invoke the repair harness for that item
- **AND** SHALL still record a hold if the item is ineligible

---

### Requirement: Merge-queue repair-hold logic SHALL be unit-tested through injected dependencies

Unit tests for merge-queue hold and repair behavior SHALL inject I/O through a deps seam
(mergeability, required checks, worktree resolution, harness invoke, merge surface) and
SHALL NOT perform real network, git, or subprocess calls. The suite SHALL cover at least:
conflict → hold; successful repair → re-eligible; budget exhaust → hold; and no merge while
required checks are red.

#### Scenario: Conflict to hold without real I/O

- **WHEN** a unit test injects a conflicted mergeability fixture for a candidate
- **THEN** the drive decision path SHALL record a `merge-conflict` hold
- **AND** SHALL NOT call the merge surface
- **AND** the test SHALL not open a real network or git connection

#### Scenario: Successful repair re-eligibility is covered

- **WHEN** a unit test sequences a held item, a successful repair push fixture, then green
  eligibility fixtures
- **THEN** the path SHALL re-evaluate gates and MAY invoke the merge surface only after
  re-gate passes

#### Scenario: Budget exhaust is covered

- **WHEN** a unit test sets max repair attempts to N and injects N failed repair or still-
  ineligible outcomes
- **THEN** the path SHALL leave the item held and SHALL NOT perform attempt N+1

#### Scenario: Red checks never merge is covered

- **WHEN** a unit test injects required checks with a blocking bucket for a candidate
- **THEN** the path SHALL record `checks-failed` (or keep that hold)
- **AND** SHALL assert zero calls to the merge surface for that candidate

