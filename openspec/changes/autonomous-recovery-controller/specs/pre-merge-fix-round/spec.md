## MODIFIED Requirements

### Requirement: Pre-merge SHALL perform at most one auto-fix attempt per entry

The pipeline SHALL perform at most one implementer auto-fix attempt for a pre-merge blocking delta
review at a given authoritative candidate identity. The durable attempt key SHALL be item,
candidate identity, reason code, and repair action rather than a worktree marker alone. Candidate-
currency checks, worktree lookup, safe rematerialization, synchronization, and clean-tree checks
SHALL be preflight and SHALL NOT consume the implementer repair attempt. Immediately before invoking
the implementer, the pipeline SHALL durably claim and charge the attempt. A successful commit,
confirmed clean no-op, harness failure, timeout, unsafe no-action, or process death after claim SHALL
consume that attempt. After a successful commit the pipeline SHALL re-run delta review exactly once
against the new head. After a clean no-op it SHALL re-verify exactly once. A candidate identity
change SHALL supersede the old attempt and require fresh eligibility computation; it SHALL not
mutate or replay the old candidate.

#### Scenario: Fix resolves the finding and pre-merge proceeds

- **WHEN** a claimed auto-fix commits a repair and the single re-run delta review approves under
  active policy
- **THEN** pre-merge SHALL proceed without another auto-fix attempt for the old candidate
- **AND** the prior evidence SHALL remain bound to that candidate

#### Scenario: Fix does not resolve the finding and consumes the attempt

- **WHEN** a claimed auto-fix commits but the single re-run still reports blocking findings
- **THEN** the keyed attempt SHALL remain consumed
- **AND** the item SHALL return a typed blocked diagnostic without a second implementer invocation

#### Scenario: Prior charged attempt is recognized after restart

- **WHEN** the durable ledger contains a claimed or completed auto-fix attempt for the same item,
  candidate, reason, and action
- **AND** the finding remains blocking
- **THEN** the pipeline SHALL NOT invoke the implementer again for that key
- **AND** it SHALL reconcile the recorded attempt result before choosing the next disposition

#### Scenario: Prior clean no-op is reverified without a second attempt

- **WHEN** a charged attempt at the current candidate ended in confirmed clean no-op
- **AND** the finding remains under evaluation
- **THEN** the pipeline SHALL run the single current-head reverify path
- **AND** it SHALL NOT invoke the implementer again for that key

#### Scenario: Process death after claim does not grant a free retry

- **WHEN** the process dies after charging the attempt and before recording its result
- **THEN** resume SHALL reconcile live candidate and postconditions against that attempt
- **AND** it SHALL not create an uncharged second implementer attempt

#### Scenario: Preflight failure does not consume implementer repair

- **WHEN** candidate-currency, rematerialization, synchronization, or clean-tree preflight fails
  before the implementer claim
- **THEN** no implementer repair unit SHALL be consumed
- **AND** the preflight failure SHALL emit its own typed diagnostic

#### Scenario: Claim persistence failure prevents implementer invocation

- **WHEN** the pipeline cannot durably claim and charge the attempt
- **THEN** it SHALL NOT invoke the implementer harness
- **AND** it SHALL return a typed engine-owned persistence failure

### Requirement: Pre-merge auto-fix SHALL rematerialize a missing managed worktree before implementer work

When pre-merge auto-fix is eligible and the managed worktree is absent, the pipeline SHALL first
reconcile the open PR head and candidate identity and then attempt safe rematerialization through
`ensureManagedWorktree`. Rematerialization and synchronization SHALL occur before the implementer
attempt is claimed, so their failure SHALL not consume the single implementer repair unit. Success
SHALL continue into the same shared auto-fix transaction on the recreated path. Failure SHALL emit
a typed `worktree-missing`, `worktree-capacity`, `worktree-dirty`, or worktree-creation diagnostic
with exact evidence and enter the controller's bounded preflight recovery. It SHALL not collapse to
a bare error or product needs-human hold. Normal delta auto-fix and residual re-entry SHALL use the
same production closure and reconciliation seam.

#### Scenario: Residual re-entry rematerializes then runs implementer

- **WHEN** residual re-entry auto-fix is eligible, the managed worktree is absent, and safe
  rematerialization succeeds for the current PR head
- **THEN** the pipeline SHALL claim and invoke auto-fix on the recreated path
- **AND** it SHALL not fail solely because the worktree was initially absent

#### Scenario: Missing worktree enters typed recovery only after rematerialize fails

- **WHEN** auto-fix is eligible, the worktree is absent, and safe rematerialization fails
- **THEN** the path SHALL return a typed worktree diagnostic containing the rematerialization error
- **AND** it SHALL not return a bare error or infer human authority

#### Scenario: Rematerialization failure does not consume implementer repair

- **WHEN** rematerialization fails before an implementer attempt is claimed
- **THEN** the implementer repair budget SHALL remain unchanged
- **AND** the worktree recovery policy SHALL account for its own bounded attempt

#### Scenario: Present worktree skips rematerialize and runs auto-fix

- **WHEN** auto-fix is eligible and a managed worktree already exists for the current candidate
- **THEN** the pipeline SHALL not recreate it solely for auto-fix
- **AND** it SHALL continue through clean-tree preflight and the bounded implementer claim

#### Scenario: Normal delta and residual re-entry share rematerialization

- **WHEN** either normal delta auto-fix or residual re-entry needs an absent worktree
- **THEN** both SHALL use the same `ensureManagedWorktree` and current-identity reconciliation seam

#### Scenario: Candidate movement prevents stale rematerialization mutation

- **WHEN** live reconciliation observes that the PR head changed before rematerialization or repair
- **THEN** the old attempt SHALL be superseded before any mutation
- **AND** eligibility SHALL be recomputed against the new head

