# recovery-episodes Specification

## Purpose
Persists candidate-scoped Recovery Episodes with a monotonic strategy cursor, per-strategy bounds, durable Cooling, write-ahead fenced claims, same-host takeover, and generation quarantine so RecoverySupervisor retains lifecycle ownership across process restart.

## Requirements

### Requirement: RecoverySupervisor SHALL persist Recovery Episodes on the shared recovery-attempt family

RecoverySupervisor SHALL persist a Recovery Episode for each supervised recovery keyed by operation, invariant, candidate epoch, and normalized evidence identity. The episode SHALL reuse the existing recovery-attempt record family and operation-claim records. The engine SHALL NOT persist a competing private episode schema as production authority. The episode SHALL survive process restart. Cursor reset SHALL require a new candidate epoch or materially different evidence. Prose variation or restart SHALL NOT reset the cursor.

Item-local Cooling created by a Recovery Episode SHALL persist the candidate epoch that created it. A later attempt for a new epoch SHALL NOT cause Cooling from the prior epoch to regain authority over the new epoch. Legacy Cooling records without an epoch MAY use attempt history only as a backward-compatible ownership inference.

#### Scenario: Episode key is candidate-scoped

- **WHEN** RecoverySupervisor starts recovery for an operation invariant on candidate epoch E with normalized evidence identity F
- **THEN** it SHALL persist or resume one Recovery Episode keyed by that operation, invariant, epoch, and evidence identity
- **AND** a later process on the same host SHALL read that same episode without minting a second identity

#### Scenario: Restart does not reset the cursor

- **WHEN** a Recovery Episode has advanced its strategy cursor to recipe R2
- **AND** the supervisor process exits and a later process resumes the same episode
- **THEN** the cursor SHALL remain at R2
- **AND** the resumed process SHALL NOT restart at the first recipe solely because the process restarted

#### Scenario: New epoch or material evidence starts a new episode

- **WHEN** the candidate identity changes to a new epoch, or the normalized evidence identity is materially different
- **THEN** RecoverySupervisor SHALL persist a new Recovery Episode for that key
- **AND** the prior episode's cursor SHALL NOT authorize treatment on the new key

#### Scenario: Prose variation does not reset the cursor

- **WHEN** two observations differ only in incidental formatting or comment prose and normalize to the same evidence identity
- **THEN** RecoverySupervisor SHALL resume the existing Recovery Episode
- **AND** SHALL NOT reset the strategy cursor

---

### Requirement: A Recovery Episode SHALL record invariant, epoch, evidence, attempts, cursor, and next_eligible_at

Each persisted Recovery Episode SHALL record the operation invariant, candidate epoch, normalized evidence identity, attempts per applicable strategy, monotonic strategy cursor, and `next_eligible_at`. Attempts per strategy SHALL be counted only for applicable strategies that were claimed. `next_eligible_at` SHALL be the earliest time the episode may run another observation or wake.

#### Scenario: Required fields are present

- **WHEN** a Recovery Episode is read after a claimed treatment
- **THEN** the record SHALL include invariant, candidate epoch, evidence identity, attempts per strategy, strategy cursor, and `next_eligible_at`
- **AND** a fixture missing any of those fields SHALL fail

#### Scenario: Attempt counts are per strategy

- **WHEN** strategy R1 is claimed twice and strategy R2 has not been claimed
- **THEN** the episode SHALL record two attempts for R1 and zero attempts for R2
- **AND** it SHALL NOT fold those counts into a single class-wide remaining budget as the production authority

---

### Requirement: Strategy exhaustion SHALL advance the cursor and SHALL NOT end ownership

Each applicable strategy SHALL have its own bounded attempts. Exhausting one applicable strategy SHALL advance the Recovery Episode strategy cursor to the next applicable configured strategy. Exhaustion of all applicable strategies SHALL enter capped exponential Cooling with a future `next_eligible_at`. Exhaustion SHALL NOT mark the Logical Operation complete, cancelled, or human-owned. Exhaustion SHALL NOT persist `run_fatal` or `recovery_exhausted` as a lifecycle stop.

#### Scenario: First strategy exhaustion advances the cursor

- **WHEN** the current applicable strategy reaches its own attempt bound without verified success
- **THEN** RecoverySupervisor SHALL advance the strategy cursor to the next applicable configured recipe
- **AND** the Logical Operation SHALL remain owned
- **AND** the next recipe SHALL be claimable without an operator resume

#### Scenario: All applicable strategies exhausted enter Cooling

- **WHEN** every applicable configured strategy on the episode has reached its own bound
- **THEN** RecoverySupervisor SHALL persist Cooling with a future `next_eligible_at`
- **AND** SHALL NOT persist `run_fatal`, `recovery_exhausted`, or another ownerless terminal as the lifecycle outcome
- **AND** historical `recovery_exhausted` MAY remain as evidence only

---

### Requirement: Inapplicable deterministic recipes SHALL NOT consume substantive repair budget

RecoverySupervisor SHALL evaluate whether a configured deterministic recipe is applicable before claiming it. An inapplicable recipe SHALL be recorded as a skip. It SHALL NOT consume the substantive repair budget of a later applicable recipe. Applicability SHALL use declared invariants and live evidence (for example absent HEAD, never-started preflight, or a recipe whose preconditions are false).

#### Scenario: Absent HEAD skips verify_head_goal without consuming repair

- **WHEN** the configured recipe order is `verify_head_goal` then `repair_pipeline_item`
- **AND** the item has no current candidate HEAD
- **THEN** RecoverySupervisor SHALL record `verify_head_goal` as inapplicable
- **AND** SHALL NOT consume the `repair_pipeline_item` attempt bound
- **AND** `repair_pipeline_item` SHALL remain reachable when a HEAD exists

#### Scenario: Never-started preflight recipes skip without charging repair

- **WHEN** a preflight never started and the remaining configured recipes are unsafe without a started harness
- **THEN** RecoverySupervisor SHALL record those recipes as inapplicable
- **AND** SHALL NOT charge a substantive repair attempt
- **AND** SHALL keep the Logical Operation owned as Cooling or an external-condition wait

---

### Requirement: Later configured recipes SHALL remain reachable in production order

RecoverySupervisor SHALL claim configured applicable recipes in production order. A class-wide remaining budget of zero SHALL NOT hide a later applicable recipe that has not spent its own bound. Round-robin selection that can skip a later recipe because an earlier recipe consumed a shared class budget SHALL NOT be production authority.

#### Scenario: Shared class budget of zero does not hide later repair

- **WHEN** a class lists `unlink_engine_scratch`, then `restart_workflow_engine`, then `repair_pipeline_item`
- **AND** earlier applicable strategies have consumed a former class-wide retry budget
- **AND** `repair_pipeline_item` has not spent its own bound
- **THEN** RecoverySupervisor SHALL still claim `repair_pipeline_item` in production order
- **AND** a fixture that terminalizes before that claim SHALL fail

---

### Requirement: Repeated evidence SHALL change treatment or enter Cooling without a tight loop

When consecutive observations on the same Recovery Episode carry the same normalized evidence identity, RecoverySupervisor SHALL either advance the strategy cursor or enter Cooling with a future `next_eligible_at`. It SHALL NOT tight-loop the same strategy in the same cycle. Differing material evidence MAY reset the repeated-evidence count for that episode. Cursor reset still SHALL require a new candidate epoch or materially different evidence.

#### Scenario: Identical evidence does not tight-loop the same strategy

- **WHEN** an item re-blocks with the same evidence identity after a claimed strategy
- **THEN** RecoverySupervisor SHALL advance the cursor or persist Cooling with `next_eligible_at` in the future
- **AND** SHALL NOT claim the same strategy again in that same cycle

#### Scenario: Cooling wake honors next_eligible_at

- **WHEN** a Recovery Episode is Cooling and the current time is before `next_eligible_at`
- **THEN** RecoverySupervisor SHALL NOT claim another treatment for that episode
- **AND** independent siblings SHALL remain schedulable

---

### Requirement: Independent siblings SHALL remain schedulable while another item cools

A waiting or Cooling item SHALL NOT abandon proven-independent siblings. Direct and transitive dependents SHALL remain excluded until their prerequisites are proven. The run SHALL NOT whole-stop solely because one item is Cooling.

#### Scenario: Sibling continues during Cooling

- **WHEN** item P is Cooling after strategy-cursor exhaustion
- **AND** item Q is proven independent of P and eligible
- **THEN** RecoverySupervisor SHALL keep Q schedulable
- **AND** SHALL NOT persist a run-level mechanical terminal solely because P is Cooling

---

### Requirement: Side-effect claims SHALL be write-ahead, candidate-bound, fenced, and reconciled before replay

RecoverySupervisor SHALL persist a write-ahead claim before an external side effect. The claim SHALL bind the candidate epoch and a stable idempotency identity. The claim SHALL require the current fenced lease token. A resumed process SHALL replay the same identity without a second charge when the claim already exists. Fencing SHALL be same-host. Remote correctness SHALL come from the stable idempotency identity and authoritative post-observation, not from a distributed lock.

#### Scenario: Claim is durable before the side effect

- **WHEN** RecoverySupervisor selects a recipe that mutates git, the forge, CI, or a worktree
- **THEN** it SHALL persist a `started` claim with the idempotency identity before that mutation
- **AND** a crash after the claim and before the mutation SHALL NOT charge a second attempt on replay of the same identity

#### Scenario: Same-host fence is required to mutate

- **WHEN** a process lacks the current fence token
- **THEN** it SHALL NOT persist a new claim or perform the claimed side effect
- **AND** the refusal SHALL name the current holder

---

### Requirement: Fenced takeover SHALL reconcile uncertain side effects before mutation

After the holding process dies on the same host, a later process SHALL claim a fresh fenced lease (process id, starttime, and a new opaque token). The dead holder's token SHALL NOT authorize mutation. Before any new mutation, takeover SHALL observe the authoritative observer for each outstanding `started` claim whose side-effect certainty is `uncertain`. Proven complete SHALL be reconciled forward. Proven absent MAY replay under the same idempotency identity. Still-unknown SHALL remain an owned wait or typed Capability Request. Takeover SHALL NOT mutate first.

#### Scenario: Dead same-host holder is taken over with a new token

- **WHEN** the lock records this host and a process id that is not alive
- **THEN** takeover SHALL recover the fence, mint a new token, and resume the same Logical Operation
- **AND** the previous token SHALL no longer authorize mutation

#### Scenario: Uncertain claim is observed before replay

- **WHEN** takeover finds a `started` claim whose certainty is `uncertain`
- **THEN** it SHALL query the declared authoritative observer before any new mutation
- **AND** if the observer proves the postcondition complete, it SHALL reconcile forward without replay
- **AND** if the observer proves the side effect absent, it MAY replay under the same idempotency identity
- **AND** if the observer cannot prove complete or absent, it SHALL keep the operation owned as a wait

#### Scenario: Cross-host lock is not auto-taken over

- **WHEN** the lock records a different hostname
- **THEN** takeover SHALL NOT classify that holder as stale
- **AND** it SHALL NOT claim cross-host mutual exclusion

---

### Requirement: Truncated, invalid, or partial durable generations SHALL be quarantined

The store SHALL detect a truncated, invalid, or partial durable generation of a Recovery Episode, claim, Cooling record, or ledger document. Detection SHALL include unreadable JSON, schema failure, leftover temporary write files, and a rename that never published. A quarantined generation SHALL NOT be treated as live authority. When a last valid generation exists, the store SHALL reconstruct from that generation plus live truth when safe. When reconstruction is unsafe, the Logical Operation SHALL remain owned as Cooling or an external-condition wait with evidence of the quarantine.

#### Scenario: Truncated ledger is not live authority

- **WHEN** a reader finds a ledger or episode document that is truncated or not valid JSON
- **THEN** the store SHALL quarantine that generation with evidence
- **AND** SHALL NOT treat it as the live Recovery Episode
- **AND** SHALL reconstruct from the last valid generation plus live truth when that last valid generation exists

#### Scenario: Leftover temporary write is not published authority

- **WHEN** a crash leaves a temporary write file beside the destination document
- **THEN** the store SHALL NOT treat that temporary file as the published generation
- **AND** the previously durable document SHALL remain the live generation when it still parses

#### Scenario: Unreconstructable generation stays owned as Cooling

- **WHEN** a quarantined generation is detected
- **AND** no last valid generation of the same document is readable
- **THEN** a holder with the current lock token SHALL persist Cooling or an external-condition wait with evidence of the quarantine
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Unauthenticated document read does not persist salvage Cooling

- **WHEN** a reader without the current lock token finds an unreconstructable generation
- **AND** no last valid generation of the same document is readable
- **THEN** the store SHALL quarantine that generation with evidence
- **AND** SHALL NOT overwrite the published document or last-valid generation
- **AND** SHALL return typed quarantine state that requires the current lock token to persist Cooling

---

### Requirement: Mechanical terminal stop reasons SHALL become owned Cooling or waits

Live mechanical `run_fatal`, `recovery_exhausted`, `repeated_no_progress`, `supervisor_no_progress`, `worktree_capacity`, and `supervisor_cycle_cap` outcomes SHALL persist as Cooling or an external-condition wait. They SHALL NOT end RecoverySupervisor ownership. Historical evidence tokens MAY remain on older records. Genuine current typed requests and authenticated cancellation SHALL remain. Cooling wake-up and bound resume SHALL NOT count as manual reinvocation.

#### Scenario: Live mechanical exhaustion stays Cooling

- **WHEN** a live drive exhausts applicable strategies, records no-progress at the cycle bound, hits residual worktree capacity, or hits the cycle safety cap
- **THEN** RecoverySupervisor SHALL persist Cooling or an external-condition wait
- **AND** SHALL NOT persist those names as a lifecycle terminal stop
- **AND** independent siblings SHALL remain schedulable when proven independent

#### Scenario: Genuine typed request is unchanged

- **WHEN** a current canonical `human-decision-required` diagnostic or typed Authority Request exists
- **THEN** RecoverySupervisor SHALL keep that typed request
- **AND** SHALL NOT convert it into Cooling solely because this capability removes mechanical terminals

---

### Requirement: Crash tests SHALL cover every durable-write and external-side-effect boundary

Hermetic tests SHALL crash or interrupt after each durable write and before each external side effect used by Recovery Episode persistence, cursor advance, Cooling, claim start, lease takeover, and generation quarantine. Each crash fixture SHALL prove the next process resumes without a second charge, without an ownerless terminal, and without mutating under a dead token. Unit tests SHALL inject store, lock, and observer fakes and SHALL NOT make real network, git, or subprocess calls.

#### Scenario: Crash after claim start does not double-charge

- **WHEN** a test interrupts after the `started` claim is durable and before the external side effect
- **THEN** replay of the same idempotency identity SHALL return the existing claim
- **AND** SHALL NOT consume another attempt on that strategy

#### Scenario: Crash during fence takeover does not keep the dead token live

- **WHEN** a test interrupts after the dead lock is removed and before the new token is published
- **THEN** the dead token SHALL NOT authorize mutation
- **AND** a later acquisition SHALL be required

### Requirement: Recovery SHALL NOT classify an actionable review-stage item as noop after a new candidate epoch

RecoverySupervisor SHALL treat a review-stage item as actionable for the new candidate epoch when a non-pipeline-internal HEAD change starts that epoch and the issue is at or is returned to `review-1` or `review-2`. Recovery SHALL persist or resume a Recovery Episode keyed to the new candidate epoch. It SHALL NOT classify the item as noop solely because checks on the new HEAD are pending. It SHALL NOT classify the item as noop solely because a prior failure episode, strategy cursor, exhaustion, or Cooling record existed for the previous epoch. Pending checks MAY still wait CI for stages that already require green checks. They SHALL NOT suppress exact-SHA review after the epoch change.

#### Scenario: Pending checks do not noop review-1 after epoch change

- **WHEN** the candidate epoch changes from S to H because of a non-pipeline-internal commit
- **AND** the issue is at `review-1` or is returned to `review-1`
- **AND** GitHub checks for H are pending
- **THEN** RecoverySupervisor SHALL NOT classify the item as noop solely from those pending checks
- **AND** SHALL keep review-1 actionable for H

#### Scenario: Prior-epoch failure episode does not noop the new epoch

- **WHEN** a Recovery Episode recorded failure, strategy exhaustion, or Cooling for candidate epoch S
- **AND** the candidate epoch then changes to H
- **THEN** RecoverySupervisor SHALL persist or resume an episode keyed to H
- **AND** SHALL NOT classify the review-stage item as noop solely from the S episode
- **AND** the S cursor SHALL NOT authorize skipping review of H
