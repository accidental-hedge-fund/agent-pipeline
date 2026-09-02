## Purpose

Defines the shared operation-invariant registry, owning-system observers, candidate-epoch invalidation, and reconcile-before-retry law so ambiguous external side effects stay RecoverySupervisor-owned instead of process success or human STOP.

## ADDED Requirements

### Requirement: Every supervised mutation SHALL register a complete operation invariant

Every supervised mutation SHALL declare precondition, postcondition, authoritative observer, candidate binding, side-effect identity, safe replay predicate, and reconstruction rule. A process exit, exception, timeout, or model response SHALL be ingress evidence, not success by itself. Verified completion SHALL require the declared observer to prove the postcondition for the bound candidate and side-effect identity. A delivery stage from `planning` through `ready-to-deploy`, a merge or merge-queue apply, or a post-ready ship phase that omits any of those fields SHALL fail a contract test that names the operation.

#### Scenario: Missing invariant field fails the contract

- **WHEN** a delivery stage, merge operation, or ship phase has no reconstruction rule or no side-effect identity
- **THEN** a contract test SHALL fail
- **AND** SHALL name that operation

#### Scenario: Exit zero is not verified completion

- **WHEN** a supervised mutation process exits 0
- **AND** the authoritative observer has not proven the postcondition for the bound candidate
- **THEN** the observation SHALL NOT mark the Logical Operation complete
- **AND** side-effect certainty SHALL NOT be `known_complete` solely because of the exit code

---

### Requirement: Owning-system observers SHALL be the authority for their facts

Git, forge, CI, release, and deployment facts SHALL come from their owning systems. The local ledger, claims, and comments SHALL record durable intent and history and SHALL NOT overrule those authorities. Run ownership, issue stage, worktree and candidate identity, commit publication, PR identity and HEAD, checks, reviews, merge containment, release, deployment, and authority validity SHALL each have one declared observer. The observer SHALL report facts only. RecoverySupervisor SHALL own treatment. The observer SHALL NOT repair the invariant.

#### Scenario: Local ledger cannot overrule a merged PR

- **WHEN** the local ledger records the item as mid-flight
- **AND** the forge observer reports the linked PR merged and contained in the fetched base
- **THEN** reconciliation SHALL treat the forge fact as authority
- **AND** SHALL NOT keep the mid-flight ledger state as truth

#### Scenario: Observer does not repair

- **WHEN** an observer reports contradictory stage labels or an unfinished rebase
- **THEN** the observer SHALL return that fact
- **AND** SHALL NOT write GitHub labels, abort the rebase, merge, push, or deploy

---

### Requirement: Reconciliation SHALL run before retry and after every recovery action

RecoverySupervisor SHALL reconcile against the declared observers before any replay and after every recovery action. Side-effect certainty of `uncertain` SHALL require that observation before replay. A locally failed attempt whose observer proves the postcondition complete SHALL be reconciled forward without replay. A proven-absent side effect MAY replay under the same side-effect identity and candidate epoch. Still-unknown state SHALL remain Cooling, an external-condition wait, or a CapabilityRequest. Reconciliation SHALL NOT perform merge, push, label write, PR edit, release, or deploy.

#### Scenario: Remotely completed side effect is not replayed

- **WHEN** a local attempt fails or times out
- **AND** the observer then proves the postcondition complete for the same side-effect identity
- **THEN** the operation SHALL complete as verified success on the original Logical Operation
- **AND** SHALL NOT replay the mutation

#### Scenario: Uncertain side effect waits

- **WHEN** a mutation times out and the observer cannot prove complete or absent
- **THEN** RecoverySupervisor SHALL keep the operation owned as Cooling or an external-condition wait
- **AND** SHALL NOT replay
- **AND** SHALL NOT project `hold-for-human` without independent typed-request evidence

#### Scenario: Recovery action is followed by reconcile

- **WHEN** a recovery recipe rematerializes a worktree or aborts an unfinished rebase
- **THEN** RecoverySupervisor SHALL observe candidate identity, worktree state, and PR identity before the next adapter attempt
- **AND** SHALL NOT treat the recipe itself as verified completion of the original mutation

---

### Requirement: Candidate movement SHALL start a new epoch and invalidate candidate-bound evidence

Candidate movement (new HEAD, rematerialized SHA, remote-advanced tip, or replacement worktree) SHALL start a new candidate epoch. Review verdicts, test results, eval results, shipcheck results, decisions, and authority evidence bound to the prior epoch SHALL be invalid for the new candidate. RecoverySupervisor SHALL require those facts to be re-proven against the new candidate before they may gate advancement. Process lifetime and retry number SHALL NOT be the epoch.

#### Scenario: New HEAD invalidates prior review verdict

- **WHEN** the candidate HEAD SHA changes after a review verdict was recorded
- **THEN** that verdict SHALL NOT authorize advancement at the new HEAD
- **AND** RecoverySupervisor SHALL treat the prior verdict as invalid for the new epoch

#### Scenario: Stale authority evidence does not survive epoch change

- **WHEN** an authority grant is bound to candidate epoch E1
- **AND** fresh reconciliation observes epoch E2
- **THEN** the grant SHALL NOT remain authoritative for E2
- **AND** a leftover `pipeline:blocked` label SHALL NOT preserve the stale authority

---

### Requirement: Durable local state SHALL be reconstructed from authoritative truth

When local ledger, claim, or worktree identity disagrees with an owning-system observer, RecoverySupervisor SHALL correct or reconstruct that local state from the observer. Reconstruction SHALL append an audited history entry and SHALL keep the Logical Operation owned. Reconstruction SHALL NOT be `hold-for-human` or train STOP unless independent typed-request evidence exists.

#### Scenario: Ledger-ahead is reconstructed locally

- **WHEN** the ledger records `merged`
- **AND** the forge observer proves the PR is still open
- **THEN** reconciliation SHALL reconstruct the local ledger to match the observer
- **AND** SHALL NOT route the item to a human
- **AND** SHALL NOT merge, close, or edit the PR as repair

#### Scenario: Claimed SHA versus on-disk HEAD is reconstructed as drift

- **WHEN** a recovery claim names SHA A
- **AND** the worktree HEAD is SHA B with an unfinished rebase and staged product dirt
- **THEN** reconciliation SHALL record local/remote drift
- **AND** SHALL NOT treat the worktree as a completed archive candidate
- **AND** SHALL NOT project `hold-for-human` solely for that SHA mismatch

---

### Requirement: Two pipeline stage labels SHALL reconcile to one observed stage

When an issue carries more than one `pipeline:*` label whose suffix is a member of `STAGES`, reconciliation SHALL derive exactly one observed stage: the member with the greatest index in `STAGES`. Reconciliation SHALL NOT throw. Train and loop SHALL consume that derived stage. Reconciliation SHALL NOT write GitHub labels to drop leftovers.

#### Scenario: Pre-merge and leftover design-gate yield pre-merge

- **WHEN** live labels include `pipeline:pre-merge` and `pipeline:design-gate`
- **THEN** the observed stage SHALL be `pre-merge`
- **AND** train SHALL NOT throw `ambiguous pipeline stage labels`
- **AND** the item SHALL remain RecoverySupervisor-owned

#### Scenario: Needs-human wins when co-present with an in-flight stage

- **WHEN** live labels include `pipeline:needs-human` and `pipeline:review-2`
- **THEN** the observed stage SHALL be `needs-human`
- **AND** typed-request evidence SHALL still be required before `hold-for-human`

---

### Requirement: A linked merged PR SHALL be recognized as remote mutation of this issue

Before opening a successor PR, rebasing the candidate, or treating advance as still needed, reconciliation SHALL observe every pull request linked to the issue, including closed and merged PRs. When any linked PR is merged and its merge-result is contained in the fetched base, the integration side effect SHALL be `known_complete`. The engine SHALL NOT open a successor PR on the same branch. The engine SHALL NOT rebase commits already contained in that squash or merge onto the merge-result.

#### Scenario: Forge squash-merge while still fix-2 is not replayed

- **WHEN** the issue is labeled `pipeline:fix-2`
- **AND** another actor squash-merges the issue's linked PR
- **AND** the merge-result is contained in the fetched base
- **THEN** reconciliation SHALL treat the merge as `known_complete`
- **AND** SHALL NOT open a second PR on the same branch
- **AND** SHALL NOT rebase squash-contained commits onto that merge

#### Scenario: Latest open PR does not hide a prior merge

- **WHEN** a later open PR exists on the same branch
- **AND** an earlier linked PR for the same issue is merged and contained
- **THEN** reconciliation SHALL still treat the integration side effect as `known_complete`
- **AND** SHALL NOT consult only the latest open PR as authority

---

### Requirement: A partial external operation SHALL be observed before retry

When one side effect of a multi-step mutation is proven complete and a later step is uncertain or dirty, reconciliation SHALL record both facts before retry. A completed archive SHALL NOT be replayed. An unfinished rebase SHALL be observed before a later archive attempt. The OpenSpec dirty-before-archive fail-closed SHALL remain when product dirt is present.

#### Scenario: Successful archive then unfinished-rebase dirt is not a second archive

- **WHEN** a first archive pass has already landed the OpenSpec change
- **AND** a later archive on the same worktree sees staged leftover change files from an unfinished rebase
- **THEN** reconciliation SHALL treat the archive side effect as `known_complete`
- **AND** SHALL treat the unfinished rebase as in-progress drift
- **AND** SHALL NOT replay the archive
- **AND** SHALL NOT skip the dirty-before-archive fail-closed

---

### Requirement: New fault shapes SHALL enter through a violated invariant not an error-name branch

A new contradiction, uncertain side effect, or remote mutation SHALL be classified by the violated operation invariant and observer fact. Production routing SHALL NOT switch on a thrown error message, incident title, or provider HTTP string as the first classification. A fixture that classifies by matching `ambiguous pipeline stage labels` or an equivalent thrown message SHALL fail a class-guard test.

#### Scenario: Contradictory labels are an invariant violation

- **WHEN** two `pipeline:*` stage labels are present
- **THEN** classification SHALL be a violated issue-stage invariant
- **AND** SHALL NOT depend on catching the string `ambiguous pipeline stage labels`

#### Scenario: Error-name branch fails the class guard

- **WHEN** a production path classifies a fault by matching a thrown message
- **THEN** the class-guard test SHALL fail
- **AND** SHALL name that path

---

### Requirement: Tests SHALL cover the closed reconcile fault set including the 1369 dogfood

Unit tests SHALL inject observation seams and SHALL perform no real network, git, or subprocess calls. The suite SHALL cover contradictory labels, remote or local drift, stale evidence, remote mutation by another actor, and partial external operations. One fixture SHALL encode the #1369 dogfood: forge squash-merge while pre-`ready-to-deploy`, worktree mid-rebase with claimed SHA unequal to on-disk HEAD and staged product dirt, labels `pipeline:pre-merge` and `pipeline:design-gate`, and a first archive success followed by a later dirty archive from an unfinished rebase. That fixture SHALL fail without the reconcile law.

#### Scenario: 1369 dogfood fixture fails without the law

- **WHEN** the injected observation reports the #1369 facts
- **AND** the reconcile law is absent
- **THEN** the fixture SHALL fail
- **AND** SHALL fail if train throws, a successor PR is opened, squash-contained commits are replayed, dirty-archive fail-closed is skipped, or the item is `hold-for-human` without typed-request evidence

#### Scenario: Closed fault set is covered

- **WHEN** the reconcile unit suite runs
- **THEN** it SHALL include fixtures for contradictory labels, remote or local drift, stale evidence, remote mutation by another actor, and partial external operations
