# merge-queue-repair-hold Specification

## Purpose
TBD - created by archiving change merge-queue-surgical-conflict-ci-repair. Update Purpose after archive.
## Requirements
### Requirement: Merge-queue drive SHALL record typed holds for conflict and red checks without force-merging

The merge-queue drive SHALL record a typed **hold** when apply/drive revalidation
or `mergePr` refusal indicates the PR is non-mergeable due to merge conflicts
(or equivalent dirty/conflict merge state) or that required checks are blocking
(fail, pending, or cancel under the merge check policy), using a stable reason
code of `merge-conflict` or `checks-failed` respectively. The drive SHALL NOT
force-merge, pass force flags to the merge surface, or bypass `mergePr` gates to
land the PR. When both conflict and blocking checks apply, the recorded reason
SHALL be `merge-conflict`.

#### Scenario: Conflicting PR becomes a merge-conflict hold

- **WHEN** apply/drive observes an open candidate with non-MERGEABLE or non-CLEAN
  merge state (e.g. `mergeable: "CONFLICTING"` or `mergeStateStatus: "DIRTY"`)
- **THEN** the queue SHALL record a hold with reason `merge-conflict`
- **AND** SHALL NOT call a force-merge path
- **AND** SHALL NOT treat the item as successfully merged

#### Scenario: Red required checks become a checks-failed hold

- **WHEN** apply/drive observes an open candidate that is otherwise mergeable but
  required checks are not in a non-blocking pass state under the merge check policy
- **THEN** the queue SHALL record a hold with reason `checks-failed`
- **AND** SHALL NOT call `mergePr` while those checks remain blocking
- **AND** SHALL NOT force-merge

#### Scenario: Conflict wins over concurrent checks-failed

- **WHEN** the same candidate is both non-mergeable/dirty and has blocking checks
- **THEN** the recorded hold reason SHALL be `merge-conflict`

---

### Requirement: Hold records SHALL include operator-visible remediation text

Each hold record SHALL include at least: PR number, linked issue number when known,
typed reason (`merge-conflict` or `checks-failed`), evidence summary (conflict or
check detail), observed head SHA when known, repair attempts used when applicable,
and remediation text that names the PR (and issue when known) and states concrete
next steps (manual fix, optional repair re-run, or `pipeline merge <pr>` after
eligibility is restored).

#### Scenario: merge-conflict remediation is actionable

- **WHEN** a `merge-conflict` hold is recorded for PR 42 linked to issue 10
- **THEN** the remediation text SHALL name PR 42 and issue 10
- **AND** SHALL instruct the operator to resolve conflicts (and optionally re-run
  with repair) before retrying merge-queue apply or `pipeline merge 42`

#### Scenario: checks-failed remediation is actionable

- **WHEN** a `checks-failed` hold is recorded for PR 42 with failing check names
- **THEN** the remediation text SHALL name PR 42
- **AND** SHALL reference the blocking checks or summary evidence
- **AND** SHALL instruct the operator to fix or wait for checks before retrying merge

---

### Requirement: Default drive policy SHALL hold the item and continue remaining candidates

The drive SHALL, on a conflict or checks-failed hold (and on budget-exhausted
manual-repair outcomes classified as holds for completeness), leave that item
unmerged, retain the hold in the run result, and **continue** processing
subsequent candidates in order. The drive SHALL NOT abandon remaining candidates
solely because one item was held. Held items SHALL remain visible in the drive
summary and SHALL count as held for release-when-complete completeness.

#### Scenario: Hold does not stop the rest of the batch

- **WHEN** apply/drive holds candidate A for `merge-conflict` and candidates B and C
  remain in the ordered list
- **THEN** the drive SHALL proceed to revalidate/process B and C
- **AND** the result SHALL still list A as held with reason `merge-conflict`

#### Scenario: Held items block queue-complete

- **WHEN** a drive finishes with one or more held items and zero remaining open
  eligible candidates
- **THEN** release-when-complete completeness evaluation SHALL treat the queue as
  incomplete due to held items

---

### Requirement: Optional repair SHALL be opt-in and default off

Surgical/mechanical repair of held items SHALL run only when explicitly enabled for
the invocation (CLI flag such as `--repair`) and/or a config key whose default is
false. When repair is disabled, the queue SHALL record the hold with remediation
text and SHALL NOT open a worktree, invoke an implementer, rebase, or push for
repair. Dry-run mode SHALL never perform repair side effects or merges.

#### Scenario: Apply without repair only holds

- **WHEN** apply/drive hits a `merge-conflict` or `checks-failed` condition and
  repair is not enabled
- **THEN** the item SHALL be held with remediation text
- **AND** no repair worktree mutation, implementer invoke, or repair push SHALL occur

#### Scenario: Dry-run never repairs

- **WHEN** merge-queue runs in dry-run mode even if a repair flag is present
- **THEN** the command SHALL NOT perform repair side effects or merges

#### Scenario: Repair enabled with budget may attempt remediation

- **WHEN** apply/drive hits a repairable hold reason, repair is enabled, and budget
  remains
- **THEN** the queue MAY attempt the remediation ladder defined in this capability
  before leaving the item held

---

### Requirement: Repair SHALL be deterministic-first and reuse the shared recovery contract

When repair is enabled, the merge-queue SHALL attempt **deterministic** remediation
appropriate to the hold class before invoking a model implementer repair. For
`merge-conflict`, deterministic remediation includes a clean rebase/restack onto the
configured integration base when safe. For `checks-failed`, deterministic remediation
includes re-querying settled check state and reusing pre-merge CI wait/classification
helpers rather than inventing a second poller. Only when the same current evidence
still requires code or conflict resolution SHALL the queue claim a mechanical repair
attempt and invoke the shared implementer repair path (`repair_pipeline_item` or the
shared mechanical-remediation transaction). The queue SHALL NOT introduce a
merge-queue-only recovery taxonomy, provider-specific model branch, or unguarded
second merge path.

#### Scenario: Deterministic rebase is attempted before implementer repair

- **WHEN** repair is enabled for a `merge-conflict` hold and budget remains
- **THEN** the path SHALL attempt deterministic clean rebase/restack first
- **AND** SHALL invoke implementer repair only if conflict evidence remains after
  deterministic remediation (or deterministic remediation is inapplicable)

#### Scenario: Implementer repair uses the shared seam

- **WHEN** mechanical repair is claimed for a held merge-queue item
- **THEN** the executor SHALL be the shared repair/mechanical-remediation path used
  by the autonomous recovery contract
- **AND** SHALL NOT hard-code a provider-specific repair branch in merge-queue code

#### Scenario: Claim before side effects

- **WHEN** an implementer repair is about to run
- **THEN** the attempt SHALL be claimed and charged against the repair budget before
  the implementer side effect
- **AND** failure or timeout of that attempt SHALL consume the charged unit

---

### Requirement: Surgical repair SHALL stay scoped to conflict or CI only

When an implementer repair runs, the prompt and allowed scope SHALL enforce
surgical-fix discipline: minimal diff that resolves the merge conflict or blocking
CI failure only; no refactors, feature work, unrelated cleanup, or scope broadening.
Destructive operations remain constrained to the managed worktree root and/or the
reviewed PR head. The repair path SHALL NOT squash-merge the PR.

#### Scenario: Repair prompt forbids feature expansion

- **WHEN** the merge-queue builds a repair prompt for a held item
- **THEN** the prompt SHALL instruct a minimal conflict-or-CI-only diff
- **AND** SHALL explicitly forbid refactors, feature work, and opportunistic cleanup

#### Scenario: Repair does not merge the PR

- **WHEN** implementer repair completes a push to the PR head
- **THEN** the repair path SHALL NOT call `mergePr` or `gh pr merge` itself as part
  of the repair transaction
- **AND** merge, if any, occurs only after re-gate in the drive loop via the existing
  merge surface

---

### Requirement: After repair the queue SHALL re-run eligibility gates before merge retry

The merge-queue SHALL, after any repair action that can change the candidate head
(rebase, push, or other candidate-moving side effect), re-evaluate eligibility
using the same gates as drive/merge: PR still open (or already-done), linked issue
still `pipeline:ready-to-deploy` (or equivalent policy), mergeable/CLEAN, and
required checks green under the merge check policy. The queue SHALL call
`mergePr` only when re-gate reports eligible. While checks are red or merge state
is conflicted/dirty, the queue SHALL NOT merge.

#### Scenario: Successful repair then green re-gate allows merge

- **WHEN** repair pushes a new head that is MERGEABLE/CLEAN with required checks
  passing
- **THEN** re-gate SHALL report eligible
- **AND** the drive MAY call `mergePr` once for that candidate through the existing
  merge surface

#### Scenario: Repair leaves checks red — no merge

- **WHEN** repair completes but required checks remain blocking on the new head
- **THEN** re-gate SHALL not treat the item as eligible for merge
- **AND** the queue SHALL NOT call `mergePr` for that head
- **AND** the item SHALL remain held as `checks-failed` (or budget-exhausted) with
  updated evidence

#### Scenario: Re-gate is mandatory after head movement

- **WHEN** a repair action changes the PR head SHA
- **THEN** the queue SHALL NOT reuse pre-repair eligibility to merge
- **AND** SHALL re-run mergeability and check gates against the new head

---

### Requirement: Repair budget SHALL bound attempts and optional wall-clock

Repair SHALL be bounded by a per-item budget for the drive session: a maximum number
of charged implementer repair attempts and, when configured, a maximum wall-clock
for repair-related work/waiting. Deterministic preflight that does not claim an
implementer attempt SHALL NOT consume the implementer attempt unit. When the budget
is exhausted without restoring eligibility, the queue SHALL leave a typed stopped /
manual-repair outcome with evidence and SHALL NOT auto-merge.

#### Scenario: Budget exhaust leaves hold with evidence

- **WHEN** repair is enabled and the last charged implementer attempt fails to restore
  eligibility (or the wall-clock deadline elapses)
- **THEN** the item SHALL remain held (or typed stopped/manual-repair for
  completeness)
- **AND** the outcome SHALL include reason, attempts used, head SHA when known, and
  conflict/check summary
- **AND** the queue SHALL NOT force-merge

#### Scenario: Zero budget means no implementer repair

- **WHEN** max implementer attempts is configured to 0 (or budget already exhausted)
- **THEN** `canAttemptRepair` (or equivalent) SHALL be false
- **AND** no implementer repair side effect SHALL run

#### Scenario: Mechanical exhaustion is not human authority by itself

- **WHEN** repair budget exhausts without an attested product or authority decision
  on the current candidate
- **THEN** the outcome SHALL be a typed engine/queue manual-repair hold with evidence
- **AND** SHALL NOT be classified as human-authority solely due to budget exhaustion

---

### Requirement: Merge-queue repair-hold logic SHALL be testable via injected dependencies

The merge-queue repair-hold logic SHALL accept injected deps for classification,
budget, remediation text, re-gate decisions, drive orchestration, PR state,
checks, worktree, repair executor, merge, and clock. Unit tests SHALL cover at
least: conflict → hold; successful repair → re-eligible; budget exhaust → hold;
no merge on red checks — with no real network, git, or subprocess calls.

#### Scenario: Conflict hold unit test

- **WHEN** a unit test feeds a conflicting eligibility snapshot into the classifier /
  drive with repair disabled
- **THEN** the result SHALL include a `merge-conflict` hold
- **AND** zero merge calls SHALL be recorded

#### Scenario: Successful repair re-eligibility unit test

- **WHEN** a unit test enables repair, stubs a successful repair that yields a clean
  green head, and stubs `mergePr` success
- **THEN** the drive SHALL re-gate as eligible and call `mergePr` once

#### Scenario: Budget exhaust unit test

- **WHEN** a unit test sets max attempts to 1, stubs repair failure, and re-gate
  remains ineligible
- **THEN** the item SHALL be held with evidence
- **AND** no further implementer repair SHALL be claimed

#### Scenario: No merge on red checks unit test

- **WHEN** a unit test presents a mergeable PR with blocking required checks
- **THEN** the drive SHALL record `checks-failed` (or leave held after failed re-gate)
- **AND** SHALL record zero successful merges for that item

### Requirement: Restack or conflict repair SHALL fail closed on a large unrelated documentation landing-page breach

When merge-queue restack, deterministic rebase, or optional surgical/mechanical repair produces a candidate head whose root `README.md` violates the `docs-landing-split` landing-page contract (including a #793-class large monolithic append unrelated to the held conflict or CI failure), the queue SHALL treat that head as **not** re-gate eligible for merge. The path SHALL fail closed or retain a typed hold with operator-visible diagnostics that name the documentation contract breach. The queue SHALL NOT force-merge, SHALL NOT treat the item as successfully repaired solely because conflict markers cleared, and SHALL NOT silently advance that head toward merge while the landing-page contract is red. This requirement does not change merge-authority rules, `auto_merge` posture, or review-policy thresholds; it is a deterministic control check on documentation contract compliance after head movement.

#### Scenario: Monolithic README after repair blocks re-gate merge eligibility

- **WHEN** repair or restack moves the PR head
- **AND** the new head's `README.md` has 400 or more lines or otherwise fails the landing-page contract enforced by the docs check surface
- **THEN** re-gate SHALL NOT report the item as eligible to merge
- **AND** the queue SHALL NOT call `mergePr` for that head as a successful repair outcome
- **AND** diagnostics or hold evidence SHALL mention the README / landing-page / docs-contract breach class

#### Scenario: Conflict resolved but landing page broken is not a clean repair

- **WHEN** implementer or deterministic repair clears merge conflicts
- **AND** the same head reintroduces a large unrelated monolithic README append
- **THEN** the item SHALL remain held or otherwise non-eligible
- **AND** SHALL NOT be classified as a successful surgical repair solely on conflict clearance

#### Scenario: Compliant lean README does not create a false hold

- **WHEN** repair or restack leaves `README.md` within the landing-page contract
- **AND** other eligibility gates pass
- **THEN** this documentation-contract rule SHALL NOT by itself hold the item

### Requirement: Merge-queue restack and repair SHALL apply candidate-integrity before re-gate eligibility

The merge-queue path SHALL run the candidate-integrity protocol (pre-manifest, post-manifest, classification, durable event) with the appropriate `mutation_method` (`restack`, `rebase`, `conflict_repair`, or `recovery_repair` as applicable) when merge-queue restack, deterministic rebase, or optional surgical/mechanical repair moves a candidate head. A classification of `scope_expansion` or `unverified` SHALL make the item not re-gate eligible for merge on that head: the queue SHALL fail closed or retain a typed hold with operator-visible diagnostics that name the integrity classification, and SHALL NOT call `mergePr` as a successful repair outcome for that head. A `semantically_equivalent` restack MAY proceed to re-gate only after current-head gates re-evaluate. This requirement generalizes surface integrity beyond the existing README landing-page-specific fail-closed rule and MUST NOT introduce unattended merge or weaken merge-authority boundaries.

#### Scenario: Scope expansion after restack is not merge-eligible

- **WHEN** merge-queue restack or repair classifies as `scope_expansion`
- **THEN** re-gate SHALL NOT report the item as eligible to merge on that head
- **AND** the queue SHALL NOT call `mergePr` for that head as a successful repair outcome
- **AND** hold or diagnostic evidence SHALL name the candidate-integrity classification

#### Scenario: Clean restack re-gates after current-head checks

- **WHEN** restack classifies as `semantically_equivalent`
- **AND** current-head eligibility gates (including CI/review/docs invariants as already required) pass
- **THEN** candidate-integrity SHALL NOT by itself hold the item
- **AND** merge remains subject to existing `mergePr` and human-authority rules

#### Scenario: Integrity failure is not a merge-authority grant

- **WHEN** classification is `unverified` after an optional repair attempt
- **THEN** the queue SHALL NOT force-merge
- **AND** SHALL NOT treat the integrity failure as authorization to skip re-gate or human merge authority

