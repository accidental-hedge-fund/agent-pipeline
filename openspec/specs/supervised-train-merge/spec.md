# supervised-train-merge Specification

## Purpose
Defines train progression, per-PR merge, and merge-queue drive as RecoverySupervisor-owned exact-candidate operations with a shared merge invariant, durable claims, remote-truth reconciliation, crash-safe exactly-once merge, and independent-sibling continuation.

## Requirements

### Requirement: RecoverySupervisor SHALL own train progression and merge operations

RecoverySupervisor SHALL be the sole lifecycle owner for train progression, per-PR merge, and merge-queue drive. Train, merge, and merge-queue surfaces SHALL report typed operation observations to RecoverySupervisor. Those surfaces SHALL NOT declare terminal lifecycle for mechanical failure, choose recovery recipes, or invent a train-local recovery state machine. `pipeline recover-parked` SHALL remain an operator CLI and SHALL NOT be a second train recoverer.

#### Scenario: Adapter reports observation without declaring terminal

- **WHEN** a merge, merge-queue, or train merge attempt fails, times out, or returns an uncertain merge response
- **THEN** the adapter SHALL emit a typed operation observation with side-effect certainty
- **AND** it SHALL NOT mark the Logical Operation complete, cancelled, or human-owned
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Train does not become a recoverer

- **WHEN** a train item parks, blocks, or fails a merge gate
- **THEN** train SHALL hand the observation to RecoverySupervisor
- **AND** it SHALL NOT invoke `recover-parked` as a train-local second recoverer
- **AND** it SHALL NOT implement a train-local retry taxonomy or STOP policy for that mechanical fault

---

### Requirement: Merge and merge queue SHALL share one merge operation invariant

Per-PR merge and merge-queue apply SHALL declare one shared operation invariant: precondition, postcondition, authoritative observer, candidate binding, and replay rule. A process exit, exception, timeout, or uncertain merge API response SHALL be ingress evidence only. Verified completion SHALL require the observer to prove the exact-candidate postcondition.

The shared invariant SHALL be:

- **precondition:** operator merge authority is current; the linked issue is at `pipeline:ready-to-deploy`; the PR is the exact integration candidate (repository, base, frozen issue scope, PR number, inspected head); mergeability is `MERGEABLE` and `CLEAN`; required checks pass; linkage is valid
- **postcondition:** that PR is merged and its merge-result is contained in the fetched configured base
- **observer:** GitHub pull-request merge state plus git ancestry of the fetched base tip
- **candidate binding:** repository, base, frozen issue scope, PR, inspected head SHA, and action identity
- **replay rule:** observe PR state and prove base containment before any replay; do not submit a second merge while the claim is complete, submitted, or uncertain

#### Scenario: Shared invariant is explicit

- **WHEN** `pipeline merge` or merge-queue apply prepares a merge
- **THEN** both SHALL use the same precondition, postcondition, observer, candidate binding, and replay rule
- **AND** a zero exit without observed merged state and base containment SHALL NOT complete the operation

#### Scenario: Merge-queue does not invent a second invariant

- **WHEN** merge-queue apply revalidates a candidate
- **THEN** it SHALL reuse the shared merge invariant
- **AND** it SHALL NOT apply a looser mergeability, checks, or head-binding rule than `pipeline merge`

---

### Requirement: A merge claim SHALL bind the exact integration candidate

A merge SHALL persist a stable claim before submission. The claim SHALL bind repository, configured base, frozen issue scope, PR number, inspected head SHA, and action identity. Fresh candidate, base, checks, review, mergeability, and linkage SHALL be observed immediately before submission. Candidate-bound merge authorization SHALL be derived only after those exact-candidate gates pass.

#### Scenario: Claim is bound before submission

- **WHEN** merge or merge-queue apply is about to invoke the squash-merge mutation
- **THEN** it SHALL persist a claim that names repository, base, frozen issue scope, PR, inspected head, and action identity
- **AND** it SHALL observe mergeability, checks, review currency, linkage, and head immediately before that mutation

#### Scenario: Moved head invalidates derived authorization

- **WHEN** the PR head SHA differs from the inspected head on the claim
- **THEN** the claim SHALL be invalid
- **AND** derived merge authorization SHALL NOT apply
- **AND** a later merge SHALL require a new exact-candidate gate pass and a new claim

---

### Requirement: Merge SHALL reconcile remote truth before retry

After timeout, crash, or uncertain merge response, merge and merge-queue SHALL observe live PR state and prove base containment before any replay. Side-effect certainty of uncertain SHALL require reconciliation before replay. Local intent history SHALL NOT overrule GitHub merge state or git ancestry.

#### Scenario: Uncertain response observes before replay

- **WHEN** a merge mutation times out or returns an uncertain response
- **THEN** the next attempt SHALL observe whether the PR is merged and whether the merge-result is contained in the fetched base
- **AND** it SHALL NOT submit a second merge until that observation is known complete or known absent

#### Scenario: Already-merged PR is not replayed

- **WHEN** reconciliation shows the claimed PR is merged and the merge-result is contained in the fetched base
- **THEN** the operation SHALL complete as verified success
- **AND** it SHALL NOT invoke the squash-merge mutation again

#### Scenario: Uncertain claim becomes retryable after absence is proven

- **WHEN** a merge claim is submitted or uncertain
- **AND** reconciliation observes the PR still open after the cooling window
- **THEN** the adapter SHALL record that the prior side effect is known absent
- **AND** it MAY start a new exact-candidate gate pass and claim under the original envelope
- **AND** it SHALL NOT wait solely because the stored outcome remains uncertain

---

### Requirement: Merge side effects SHALL be exactly-once across crash boundaries

Merge submission SHALL be exactly-once for one valid claim. A completed side effect SHALL not be replayed. A crash before submission, after submission, or after response persistence SHALL leave the operation owned and SHALL reconcile the observer on the next process.

#### Scenario: Crash before submission does not merge

- **WHEN** the process dies after the claim is started and before the merge mutation is submitted
- **THEN** a fresh process SHALL observe that the PR is still unmerged
- **AND** it MAY submit the merge only after re-proving exact-candidate gates for the same inspected head
- **AND** it SHALL NOT leave the Logical Operation ownerless

#### Scenario: Crash after submission reconciles instead of replaying

- **WHEN** the process dies after the merge mutation is submitted and before the response is persisted
- **THEN** a fresh process SHALL observe live PR state and base containment
- **AND** if the merge completed, it SHALL NOT submit a second merge
- **AND** if the merge is unproven, RecoverySupervisor SHALL keep the operation owned
- **AND** it SHALL NOT submit a second merge while remote visibility of that submission remains delayed

#### Scenario: Crash after response persistence does not remarge

- **WHEN** the process dies after a known-complete merge response is persisted
- **THEN** a fresh process SHALL treat the merge as complete for that claim
- **AND** it SHALL NOT invoke the squash-merge mutation again

#### Scenario: Concurrent processes submit merge at most once

- **WHEN** two processes for the same repository and PR both pass exact-candidate gates
- **THEN** only the process that atomically acquires the claim transition to `submitted` SHALL invoke the squash-merge mutation
- **AND** the competing process SHALL reconcile or wait
- **AND** it SHALL NOT persist a second `submitted` claim for that PR

#### Scenario: Relinked issue refuses the frozen scope

- **WHEN** the frozen candidate scope names issue A
- **AND** a fresh inspection or final pre-submit read shows the PR currently closes issue B
- **THEN** the adapter SHALL NOT bind or submit the merge claim
- **AND** it SHALL NOT invoke the squash-merge mutation

#### Scenario: Retargeted base refuses the configured base

- **WHEN** the claim or supervision records configured base `main`
- **AND** a fresh inspection or final pre-submit read shows `baseRefName` other than `main`
- **THEN** the adapter SHALL NOT submit merge
- **AND** derived candidate-bound authorization SHALL be invalid

#### Scenario: Cooling is measured from the latest submitted or uncertain transition

- **WHEN** a claim enters `submitted` or `uncertain`
- **THEN** the adapter SHALL persist a transition timestamp for that outcome
- **AND** replay cooling SHALL use that latest timestamp
- **AND** it SHALL NOT treat `started_at` as the cooling origin after submission or uncertainty

---

### Requirement: Conflict, check drift, head drift, unknown mergeability, timeout, and uncertain merge response SHALL remain owned

Those six classes SHALL remain RecoverySupervisor-owned (active, Cooling, or external-condition wait). They SHALL NOT become ownerless STOP, human authority, or a requirement that a human reinvoke the command solely because the process died, the merge response was uncertain, or a bounded repair budget was exhausted. Genuine typed Authority Requests MAY still park only the affected issue.

#### Scenario: Unknown mergeability stays owned

- **WHEN** mergeability remains `UNKNOWN` after the bounded mergeability budget
- **THEN** RecoverySupervisor SHALL keep the merge operation in Cooling or an external-condition wait
- **AND** the adapter SHALL NOT treat UNKNOWN as MERGEABLE
- **AND** the Logical Operation SHALL NOT become ownerless

#### Scenario: Conflict stays owned without force-merge

- **WHEN** the observer reports `CONFLICTING` or dirty merge state
- **THEN** RecoverySupervisor SHALL keep the operation owned
- **AND** the adapter SHALL NOT force-merge
- **AND** proven-independent siblings MAY continue

#### Scenario: Uncertain merge response stays owned

- **WHEN** `gh pr merge` times out or returns output that does not prove success or absence
- **THEN** side-effect certainty SHALL be uncertain
- **AND** RecoverySupervisor SHALL keep the operation owned until reconciliation proves complete or absent

---

### Requirement: Train SHALL continue proven-independent work while another item waits or cools

A waiting or cooling item SHALL NOT abandon proven-independent siblings. Direct and transitive dependents SHALL remain excluded until their code prerequisites are proven integrated (merged and contained in the fetched base). Merge concurrency SHALL remain one.

#### Scenario: Independent sibling continues during Cooling

- **WHEN** item P is Cooling or waiting on merge conflict, checks, or unknown mergeability
- **AND** item S is proven independent and still schedulable
- **THEN** train SHALL continue S
- **AND** SHALL NOT whole-train STOP solely because P is waiting or cooling

#### Scenario: Dependent stays excluded until integration is proven

- **WHEN** item B depends on item A
- **AND** A is waiting, cooling, or unmerged
- **THEN** train SHALL exclude B from advance and merge waves
- **AND** after A's merge-result is contained in the fetched base, B MAY enter a later frontier

---

### Requirement: Merge authority SHALL come only from the original typed envelope

Operator invocation SHALL authorize the frozen train or merge-queue scope (`pipeline merge <pr>`, `pipeline merge-queue --apply`, or `pipeline train --merge`). Candidate-bound merge authorization SHALL be derived only after exact-candidate gates pass and MUST be re-derived after candidate movement. Authority SHALL NOT be widened by repository configuration, host retry, recover-parked, observational events, or a second grant schema.

#### Scenario: Envelope is not widened on retry

- **WHEN** a merge retry or train resume runs after crash or Cooling
- **THEN** the retry SHALL use the original operator envelope
- **AND** it SHALL NOT gain merge authority from `.github/pipeline.yml`, an `auto_merge` key, or recover-parked

#### Scenario: Head movement requires re-derived candidate authorization

- **WHEN** the PR head moves after the operator envelope was accepted
- **THEN** candidate-bound merge authorization SHALL be invalid
- **AND** merge SHALL proceed only after a new exact-candidate gate pass under the same original envelope
