## MODIFIED Requirements

### Requirement: Blocked recovery SHALL outrank bare open-PR discovery
When the ledger records an item as `blocked`, a verified open PR alone SHALL NOT constitute
`ledger-behind` drift and SHALL NOT repair the item to `pr_opened`, regardless of the live pipeline
stage label. Reconciliation SHALL preserve the blocked state, its class, evidence, remaining budget,
and any `started` recovery attempt when the same candidate remains current or the block's originating
candidate cannot be proved. Every new block with a candidate SHALL durably bind the logical candidate
epoch that produced its evidence. An explicitly unobservable block-boundary candidate SHALL remain
unbound rather than borrowing a cached earlier identity. A legacy block MAY recover its binding only
from the first recovery attempt strictly after the latest actual `in_progress` to `blocked`
transition, only when that attempt carries a valid candidate binding, and only when that transition matches the current blocker class and fingerprint;
ambiguous, malformed, inconsistent, equal-time, non-canonical timestamp, duplicate, or non-monotonic sequence evidence SHALL fail closed.
Candidate sameness SHALL require compatible PR identity when blocker evidence positively names a PR;
head overlap alone SHALL NOT make a different PR the same candidate. A valid logical/raw head pair MAY
continue to identify the same candidate when lineage later becomes unobservable.

When a fresh authoritative observation instead proves that the block belongs to an older candidate,
the current PR remains open and advance-still-needed, the blocked label is positively absent, and the
current implementation candidate is exact and clean (no positively observed local/remote mismatch,
rebase, or product dirt; exact artifact/head binding; known-absent integration; and matching operation or retained
legacy PR binding), RecoverySupervisor SHALL atomically supersede every `started` attempt from the old
block generation, clear its item-local Cooling and obsolete advance linkage, project the observed
stage, transition the item to `in_progress`, and permit ordinary whole-item dispatch. CI success SHALL
NOT be required for this re-admission; the ordinary pipeline owns diagnosis of pending or failed CI.
A provably moved candidate that lacks any other required proof SHALL defer without executing or
minting a recovery episode from the old evidence. A started candidate-changing
`repair_pipeline_item` claim bound to the original candidate retains ownership until its existing
postcondition path resolves; stale sibling claims SHALL be retired before that owner resumes. Every
selected claim under a concrete current PR SHALL carry bounded, unambiguous candidate fields. Verified
ready-to-deploy or merged truth SHALL continue to supersede
recovery through normal forward repair.

#### Scenario: Open PR and needs-human label preserve blocked recovery
- **WHEN** the ledger item is `blocked` with a started recovery attempt
- **AND** live observation reports an open PR and `pipeline:needs-human`
- **THEN** reconciliation SHALL record no `ledger-behind` drift from PR existence alone
- **AND** the item SHALL remain blocked with the same started attempt and budget

#### Scenario: Restart replays the same attempt
- **WHEN** a supervisor resumes the blocked item after the prior process stranded an attempt as `started`
- **AND** the same candidate PR remains open
- **THEN** the supervisor SHALL reconcile and re-enter that attempt identity
- **AND** SHALL NOT charge another attempt or replay a completed model side effect

#### Scenario: Exact new candidate supersedes stale blocker generation
- **WHEN** a block and its first recovery attempt are bound to candidate A
- **AND** fresh observation proves a different exact, clean, open, advance-still-needed implementation candidate B with the blocked label positively absent
- **THEN** RecoverySupervisor SHALL atomically re-admit the item for ordinary dispatch and supersede every started attempt derived from that block generation, including attempts wrongly rebound to B
- **AND** SHALL clear A-owned Cooling and obsolete linkage without executing a recovery recipe from A's evidence

#### Scenario: New candidate remains ordinary pipeline work with non-green CI
- **WHEN** candidate B otherwise satisfies the exact clean re-admission proof
- **AND** B's checks are pending or failed
- **THEN** B SHALL still be re-admitted to the ordinary pipeline
- **AND** the old block's recovery evidence SHALL NOT diagnose or repair B

#### Scenario: Incomplete movement proof fails closed
- **WHEN** a candidate differs from the block binding but the blocked label remains present or unobservable, the candidate is dirty or rebasing, integration or artifact identity is uncertain, or operation/legacy PR binding does not match
- **THEN** the item SHALL remain blocked and recovery SHALL defer
- **AND** no current-candidate recovery episode SHALL be minted from the old block evidence

#### Scenario: Concrete current PR with an unbound legacy block fails closed
- **GIVEN** a legacy blocked item whose block generation cannot be bound to one concrete candidate
- **AND** observation reports a concrete current open implementation PR and head
- **WHEN** blocked recovery preflight runs
- **THEN** the item SHALL remain blocked and no recovery episode SHALL be executed or minted from the unbound evidence

#### Scenario: Candidate-changing repair retains postcondition ownership
- **WHEN** a started `repair_pipeline_item` claim bound to candidate A produces candidate B before its postcondition observation completes
- **THEN** the existing claim SHALL retain ownership and use the candidate-changing postcondition path
- **AND** a repair claim wrongly rebound to B from A's stale block generation SHALL NOT receive that exception

#### Scenario: Ready truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with the ready-to-deploy label
- **THEN** reconciliation SHALL repair the item forward to `ready`
- **AND** SHALL terminalize the obsolete started attempt as superseded

#### Scenario: Merged truth supersedes blocked recovery
- **WHEN** a blocked item is freshly verified with a merged PR
- **THEN** reconciliation SHALL repair the item forward to `merged`
