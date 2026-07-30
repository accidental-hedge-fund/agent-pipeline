## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform at most one auto-fix attempt per entry

The pipeline SHALL perform **at most one** auto-fix attempt for a given pre-merge blocking delta
review. An auto-fix attempt SHALL count whether it produces a fix commit **or** ends in a confirmed
clean no-commit outcome (`headAfter === headBefore` with nothing salvageable). After a successful
auto-fix commit the pipeline SHALL re-run the delta review exactly once against the new head; if
that re-review still returns blocking findings the pipeline SHALL set `blocked`/`needs-human` and
SHALL NOT attempt a second auto-fix. After a clean no-commit outcome the pipeline SHALL re-verify
the findings against the current head exactly once (see the clean-noop re-verify requirement) and
SHALL NOT attempt a second auto-fix. The bound SHALL be crash-safe: the durable marker SHALL be either the auto-fix commit
(documented subject prefix) **or** a trusted durable record of an auto-fix attempt at the head
SHA. The pipeline SHALL post an **attempt-started** durable record (for example a
pipeline-authored audit comment or sentinel that survives process restart and host switch)
**before** invoking the implementer harness, so a process crash mid-harness or a failure to
persist the post-noop completion marker still exhausts the bound on re-entry. A post-noop
completion marker MAY still be recorded for evidence, but the one-attempt bound MUST NOT depend
on it alone. When the attempt-started record cannot be posted, the pipeline SHALL NOT invoke the
harness and SHALL fail closed (escalate) so an unbound attempt is never started.

#### Scenario: fix resolves the finding — pre-merge proceeds

- **WHEN** the auto-fix attempt commits a fix and the single re-run delta review returns `approve`
  (or all findings fall below the active `review_policy`)
- **THEN** the pipeline SHALL return without blocking (pre-merge proceeds)
- **AND** SHALL NOT attempt a further auto-fix

#### Scenario: fix does not resolve the finding — escalate, no second attempt

- **WHEN** the auto-fix attempt commits a fix but the single re-run delta review still returns
  blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness a second time

#### Scenario: prior auto-fix commit is recognized after a restart

- **WHEN** the developer commits since the last reviewed SHA already include a pre-merge auto-fix
  commit (recognized by its documented subject prefix)
- **AND** the current delta review still returns blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again for this entry

#### Scenario: prior clean no-op auto-fix is recognized without a second attempt

- **WHEN** a trusted durable record shows a pre-merge auto-fix already attempted at the current
  head with a clean no-commit (noop-clean) outcome
- **AND** the current delta review still returns blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again for this entry

#### Scenario: prior attempt-started record is recognized without a second attempt

- **WHEN** a trusted durable attempt-started record exists for the current head (even when no
  noop-clean completion marker or auto-fix commit is present)
- **AND** the current delta review still returns blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT invoke the auto-fix harness again for this entry

#### Scenario: noop completion marker post fails after harness — bound still holds

- **WHEN** the harness ends noop-clean and posting the noop-clean completion marker fails
- **AND** the attempt-started durable record was already posted for that head
- **THEN** a later pre-merge entry at the same head SHALL NOT invoke the auto-fix harness again
- **AND** the current entry SHALL still re-verify (or fail closed) rather than treating the
  marker-post failure as an unbound retry

#### Scenario: attempt-started post fails — harness not invoked

- **WHEN** the pipeline cannot post the attempt-started durable record before the harness
- **THEN** the pipeline SHALL NOT invoke the implementer harness
- **AND** SHALL escalate fail-closed for that entry

### Requirement: The pre-merge auto-fix SHALL reuse the surgical-fix prompt and roll back on failure

The auto-fix attempt SHALL invoke the implementer harness with the surgical-fix prompt
(`buildFixPrompt`, #235) scoped to the blocking delta-review findings, run from the issue worktree,
so the minimal-diff discipline, the destructive-operation guard, and the pre-commit self-check apply
unchanged. The attempt SHALL require a clean worktree before starting (fail closed otherwise). On
harness error, a worktree left dirty/uncommitted with no successful salvage, or an ambiguous partial
state, the pipeline SHALL roll the worktree back to the pre-fix HEAD over a clean tree and escalate
to `needs-human`; it SHALL NOT push a partial fix. A confirmed clean no-commit outcome
(`headAfter === headBefore`, worktree clean, nothing salvageable) is **not** treated as an immediate
hard block: the pipeline SHALL return a distinct noop-clean outcome (see clean-noop re-verify
requirement) after any no-op rollback, and the caller SHALL re-verify rather than set `blocked` solely
from the absence of a commit.

#### Scenario: auto-fix prompt is the surgical-fix prompt

- **WHEN** the pipeline builds the pre-merge auto-fix prompt
- **THEN** it SHALL use `buildFixPrompt` output (not a looser prompt), carrying the minimal-diff
  instruction, the destructive-operation guard, and the pre-commit self-check

#### Scenario: harness failure with dirty or partial state rolls back and escalates

- **WHEN** the auto-fix harness invocation fails with a dirty worktree that is not successfully
  salvaged, or leaves an ambiguous partial state that is not a confirmed clean no-commit
- **THEN** the pipeline SHALL restore the pre-fix HEAD over a clean worktree
- **AND** SHALL set `blocked`/`needs-human`
- **AND** SHALL NOT push a partial fix to the PR head

#### Scenario: dirty worktree before the attempt fails closed

- **WHEN** the worktree has uncommitted changes before the auto-fix attempt starts
- **THEN** the pipeline SHALL NOT invoke the auto-fix harness
- **AND** SHALL escalate to `needs-human` without mutating git state

#### Scenario: confirmed clean no-commit is noop-clean, not immediate needs-human

- **WHEN** the auto-fix harness exits with `headAfter === headBefore` and a clean worktree with
  nothing salvageable
- **THEN** the pipeline SHALL expose a distinct noop-clean outcome (not a generic unrecoverable
  error alone)
- **AND** SHALL NOT set `blocked`/`needs-human` solely because no commit was produced
- **AND** SHALL proceed to the clean-noop re-verify path

## ADDED Requirements

### Requirement: Pre-merge auto-fix clean no-op SHALL re-verify findings against current HEAD

The pipeline SHALL, when a bounded pre-merge auto-fix attempt ends with a confirmed clean
no-commit outcome (`headAfter === headBefore`, worktree clean, nothing salvageable), re-verify every
still-open blocking finding from that delta round against the **current** PR head before any
`needs-human` escalation. Re-verify SHALL be exactly one of: (a) a single delta review re-run over
`last-reviewed-sha...HEAD` at the unchanged head, reusing the post-auto-fix re-review machinery and
ceiling rules (no review-2 budget consumption), or (b) an equivalent deterministic HEAD check that
proves each blocking finding is or is not still true at that head. The re-verify SHALL NOT count as a
second auto-fix attempt and SHALL NOT invoke the implementer harness again for that entry. The
pipeline SHALL record durable evidence of the noop-clean attempt so the one-attempt bound holds on
restart.

#### Scenario: auto-fix no-commit and re-verify clean — pre-merge proceeds

- **WHEN** the bounded auto-fix ends noop-clean
- **AND** the single re-verify reports no blocking findings under the active `review_policy`
  (finding gone, not reproducible, or proven already fixed on HEAD)
- **THEN** the pipeline SHALL return without setting `blocked`/`needs-human`
- **AND** SHALL allow remaining pre-merge gates to continue
- **AND** SHALL record evidence that auto-fix was a no-op because the code already matched the
  recommendation or the delta finding was a false positive
- **AND** SHALL NOT launch a second auto-fix attempt

#### Scenario: auto-fix no-commit and re-verify still broken — needs-human once

- **WHEN** the bounded auto-fix ends noop-clean
- **AND** the single re-verify still reports one or more blocking findings
- **THEN** the pipeline SHALL set `blocked`/`needs-human` exactly once for that entry
- **AND** SHALL NOT invoke the auto-fix harness a second time
- **AND** the block body SHALL follow the no-op still-broken recipe (see block-comment requirement)

#### Scenario: re-verify is not a second fix attempt

- **WHEN** a noop-clean outcome triggers re-verify
- **THEN** the implementer harness SHALL NOT be invoked again for the same pre-merge entry
- **AND** the `max_adversarial_rounds` counter SHALL NOT be incremented by the re-verify

#### Scenario: re-verify unavailable fails closed

- **WHEN** the noop-clean path cannot obtain a re-verify result (reviewer unparseable, head currency
  unknown, or required seams unavailable)
- **THEN** the pipeline SHALL NOT treat the no-op as approval
- **AND** SHALL take the existing conservative re-review or `needs-human` fail-closed path

### Requirement: Pre-merge auto-fix terminal block comments SHALL distinguish no-op outcomes

The pipeline SHALL, when it escalates or discloses after a pre-merge auto-fix attempt, make the
operator-facing block or diagnostic body distinguish these cases:

| Case | Required message contract |
|------|---------------------------|
| Auto-fix noop-clean, re-verify clean | MUST NOT set `blocked`/`needs-human` for the no-op alone; evidence records no-op already-fixed / false-positive |
| Auto-fix noop-clean, re-verify still broken | MUST include that auto-fix made no diff and the finding is still present at a named path (or equivalent explicit human-fix recipe) |
| Auto-fix failed / dirty / timeout / salvage failure | Existing error, salvage, and #553 disclosure contracts apply |

A bare *“no recoverable work”* disclosure alone SHALL NOT be the sole reason to hard-block when
re-verify has not yet run. When re-verify still blocks, the body MAY retain the #553 worktree path
disclosure in addition to the still-broken recipe.

#### Scenario: still-broken no-op block names path and no-diff

- **WHEN** auto-fix ends noop-clean and re-verify still blocks
- **THEN** the `needs-human` comment or block reason SHALL state that auto-fix produced no diff
- **AND** SHALL name that the finding is still present (including a cited path when the finding
  carries one)
- **AND** SHALL NOT claim only that the worktree was clean with no further recipe

#### Scenario: re-verify clean does not leave a blocking no-recoverable-work comment as authority

- **WHEN** auto-fix ends noop-clean and re-verify is clean
- **THEN** the pipeline SHALL NOT leave `pipeline:blocked` set solely for the clean no-op
- **AND** SHALL NOT treat a prior “no recoverable work” diagnostic as blocking authority

### Requirement: Pre-merge clean-noop re-verify SHALL be covered by regression tests

The test suite SHALL cover the pre-merge clean-noop re-verify path using dependency-injection seams
(no real harness, git, or network) and SHALL include at least: (1) noop-clean then re-verify approve
→ pre-merge proceeds, no `setBlocked` for the no-op; (2) noop-clean then re-verify still blocking →
exactly one `needs-human` with the still-broken recipe; (3) second auto-fix is not launched after
noop-clean; (4) a #683-class stale classification finding that is already fixed on HEAD does not
hard-block when re-verify (or the deterministic HEAD check) is clean. Each test SHALL fail (bite) if
the corresponding behavior is removed.

#### Scenario: noop-clean approve path regression bites

- **WHEN** the re-verify branch is removed so a clean no-commit auto-fix falls through to
  `needs-human` without re-verify
- **THEN** the noop-clean → proceed test SHALL fail

#### Scenario: one-attempt after noop-clean regression bites

- **WHEN** the bound ignores durable noop-clean markers and launches a second auto-fix
- **THEN** the no-second-attempt test SHALL fail

#### Scenario: #683-class stale classification does not hard-block when HEAD is already correct

- **WHEN** a fixture models a delta blocking finding that claims incorrect classification on a path
  that at HEAD already implements the recommended control-flow (for example routing an off-ramp to
  `needs-human` rather than inflating `openspec-invalid`)
- **AND** auto-fix ends noop-clean and re-verify (or the deterministic HEAD check) reports clean
- **THEN** the pipeline SHALL proceed without `needs-human` for that finding
- **AND** the test SHALL fail against the pre-change hard-block-on-clean-no-commit behavior
