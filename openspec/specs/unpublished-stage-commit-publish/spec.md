# unpublished-stage-commit-publish Specification

## Purpose
Recover a pre-PR park that already holds a pipeline-authored salvage or checkpoint commit by publishing that commit through engine-owned push, PR creation, and stage transition, so the next identical timeout does not require a new mole issue.

## Requirements

### Requirement: The engine SHALL classify a publishable unpublished stage commit

The engine SHALL treat a local HEAD as a **publishable unpublished stage commit** when all of the following hold:

1. HEAD is on the managed issue branch for the parked issue (`pipeline/<N>-*`).
2. The worktree is clean of unknown product dirt (engine-known scratch MAY remain classified as scratch).
3. At least one commit is ahead of `origin/<base>` (or the configured base).
4. No linked open PR exists for that managed head.
5. The unpublished tip is pipeline-authored salvage, ownership-checkpoint, or implement work (salvage subject prefix, ownership-checkpoint authorship, or an implement commit carrying the issue trailers). Operator-authored unmarked commits SHALL NOT match.

A timeout, harness failure, or process death that left that commit SHALL NOT by itself exclude the commit from this class.

#### Scenario: Timeout salvage on the managed branch is publishable

- **WHEN** implementing times out
- **AND** the managed worktree HEAD is a salvage or ownership-checkpoint commit on `pipeline/<N>-*`
- **AND** porcelain has no unknown product dirt
- **AND** no linked open PR exists
- **THEN** the classifier SHALL report a publishable unpublished stage commit

#### Scenario: Unknown product dirt is not publishable

- **WHEN** a salvage or checkpoint commit exists on the managed issue branch
- **AND** unknown product path `U` is dirty
- **THEN** the classifier SHALL NOT report a publishable unpublished stage commit
- **AND** SHALL NOT push, create a PR, or transition to `review-1`

#### Scenario: Unmarked operator commits are not publishable

- **WHEN** local HEAD is ahead of base on the managed issue branch
- **AND** the unpublished tip has no pipeline salvage, checkpoint, or implement authorship proof
- **THEN** the classifier SHALL NOT report a publishable unpublished stage commit
- **AND** SHALL NOT adopt that commit as engine-owned publish work

#### Scenario: Failed PR discovery is not treated as no open PR

- **WHEN** linked-open-PR lookup throws (auth, network, or API error)
- **AND** no fallback branch lookup succeeds
- **THEN** the classifier SHALL NOT report a publishable unpublished stage commit
- **AND** SHALL treat PR linkage as indeterminate
- **AND** SHALL NOT start a new publish attempt solely because the lookup failed

---

### Requirement: The engine SHALL publish a matching commit through the existing post-implement path

When the unpublished-stage classifier matches and the shared implement-deliverable observer authoritatively proves that the exact current candidate satisfies the product implementation postcondition, the engine SHALL run the existing post-implementation sequence: format and test gates, then push the managed branch without force-push, then create or find the implementation PR with the established issue-closing reference, then transition `implementing → review-1` through engine-owned state. The proof SHALL identify the implementation candidate and Candidate epoch and SHALL be distinct from planning-artifact identity. The engine SHALL NOT skip those gates or substitute a planning artifact, planning-only salvage/checkpoint commit, process result, label, comment, ledger entry, or merged planning PR for implementation proof. The same recipe identity `publish_unpublished_stage_commit` SHALL remain shared by same-process timeout, autonomous recovery, and `recover-parked`.

When exact-candidate implementation is not proved, the engine SHALL NOT publish to `review-1`. RecoverySupervisor SHALL retain durable ownership and select implementation re-entry, reconstruction, cooling, an external wait, or a valid typed request under existing policy.

#### Scenario: Validated unpublished commit reaches review-1

- **WHEN** the unpublished-stage classifier matches
- **AND** the exact current candidate's product implementation postcondition is authoritatively proved
- **AND** format and test gates pass
- **AND** push and PR creation succeed
- **THEN** the engine SHALL open or reuse the implementation PR and transition to `review-1`
- **AND** SHALL retain the existing non-force and issue-linking invariants

#### Scenario: Planning-only salvage is not published as implementation

- **WHEN** a timeout leaves a publishable-authorship salvage or checkpoint commit
- **AND** its material delta is only a planning or specification artifact
- **THEN** the engine SHALL NOT enter format/test publication as completed implementation
- **AND** SHALL NOT create an implementation PR or transition to `review-1`
- **AND** RecoverySupervisor SHALL resume or schedule implementation work

#### Scenario: Failing test gate does not open a PR

- **WHEN** the classifier matches and current implementation proof exists
- **AND** the test gate exits non-zero
- **THEN** the engine SHALL report the established test-gate failure under RecoverySupervisor ownership
- **AND** SHALL NOT create a PR or transition to `review-1`

#### Scenario: Incomplete implement is not published to review-1

- **WHEN** a timeout left a salvage or checkpoint commit
- **AND** exact-candidate implementation proof is absent or unsatisfied
- **THEN** the engine SHALL NOT create a PR solely to recover the timeout
- **AND** SHALL NOT transition to `review-1`
- **AND** RecoverySupervisor SHALL retain the incomplete implementing work

#### Scenario: Production publish requires the implement-deliverable probe

- **WHEN** the production publish executor lacks the authoritative implementation-candidate observer
- **THEN** it SHALL refuse gates, push, PR creation, and transition
- **AND** the admitted operation SHALL remain durably owned

#### Scenario: Force-push is refused

- **WHEN** the publish recipe runs for a proved implementation candidate
- **THEN** the engine SHALL use the existing non-force, currency-checked push path
- **AND** SHALL NOT use force-push or force-with-lease

#### Scenario: Candidate movement invalidates publish proof

- **WHEN** implementation proof was recorded for candidate epoch `E1`
- **AND** HEAD moves to candidate epoch `E2` before publication
- **THEN** publication SHALL be refused until implementation and required gates are re-proved for `E2`

### Requirement: Publication failure SHALL retain the worktree and remain recoverable

When push or PR creation fails after the classifier matched, the engine SHALL retain the managed worktree, keep the item parked with recovery evidence that names the publish failure, and SHALL NOT mint `needs-human` or `human-decision-required` solely for that failure. A later `recover-parked` (or equivalent autonomous recovery claim of `publish_unpublished_stage_commit`) SHALL retry publication from the retained worktree. Residual owned-leftover or publish-failure blocks SHALL stay `harness-failure` (projects `workflow-engine-defect`, disposition recover).

#### Scenario: Push failure retains and retries

- **WHEN** the classifier matches and gates pass
- **AND** push fails
- **THEN** the engine SHALL retain the managed worktree
- **AND** SHALL park with recovery evidence naming the push failure
- **AND** SHALL NOT use `needs-human` solely for that failure
- **AND** a later `recover-parked` for that issue SHALL retry `publish_unpublished_stage_commit` rather than exit `fail-closed` with `no linked open PR; keep park`

#### Scenario: PR creation failure retains and retries

- **WHEN** the classifier matches, gates pass, and push succeeds
- **AND** PR creation fails
- **THEN** the engine SHALL retain the worktree
- **AND** SHALL park with recovery evidence naming the PR-creation failure
- **AND** a later `recover-parked` SHALL retry create-or-find PR rather than fail-closed solely because no PR exists yet

---

### Requirement: The next identical unpublished timeout SHALL use this recipe

The engine SHALL NOT encode this recover as an implementing-only `afterRound` special case that other product-mutating stages cannot share. Fix-round or another pre-PR product-mutating timeout that leaves a matching salvage or checkpoint commit SHALL hit the same classifier and `publish_unpublished_stage_commit` recipe. A unit-test drift guard SHALL fail if a new same-process timeout park site proceeds to `setBlocked` on harness timeout while a publishable unpublished stage commit is present and the site does not consult the classifier.

#### Scenario: Fix-round unpublished timeout uses the same recipe

- **WHEN** a fix-round harness times out
- **AND** a salvage or ownership-checkpoint commit is publishable unpublished under the same classifier (no open PR, managed branch, clean of unknown dirt)
- **THEN** the engine SHALL claim `publish_unpublished_stage_commit`
- **AND** SHALL NOT require a new issue-specific mole to publish that commit

#### Scenario: Timeout park without classifier consult fails the suite

- **WHEN** a same-process timeout path would `setBlocked` for harness timeout
- **AND** a publishable unpublished stage commit is present
- **AND** that path does not consult the shared classifier
- **THEN** the unit suite SHALL fail
