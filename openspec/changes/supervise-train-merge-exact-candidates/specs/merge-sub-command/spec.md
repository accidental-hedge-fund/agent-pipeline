## ADDED Requirements

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
