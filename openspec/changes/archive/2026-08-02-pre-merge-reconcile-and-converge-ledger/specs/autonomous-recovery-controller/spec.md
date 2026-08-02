## ADDED Requirements

### Requirement: Recovery-attempt records SHALL expose extended stage-shared fields

The shipped recovery-attempt record used by the autonomous recovery controller SHALL remain the
single attempt family for supervisor recovery and stage-local recovery one-shots. Records SHALL
support (additively if not already present): action status, typed reason, attempt budget remaining,
last error, `next_attempt_at` / `not_before`, idempotency key, and terminal outcome among success,
failed, and superseded. Stage-local pre-merge and worktree recoveries SHALL claim through this
family via the stage-attempt ledger API rather than private books.

#### Scenario: Stage CI recovery claim is visible to supervisor hydration

- **WHEN** a pre-merge CI recovery action claims `(headSha, action)` through the stage-attempt ledger
- **THEN** the underlying recovery-attempt family SHALL retain that claim
- **AND** a supervisor or resumed process hydrating the same item/candidate SHALL observe the claim
  without reading a private stage-only JSON authority

#### Scenario: Extended fields round-trip across restart

- **WHEN** an attempt is persisted with typed reason, budget remaining, last error, and
  `next_attempt_at`
- **AND** the process restarts
- **THEN** hydration SHALL restore those fields for eligibility and operator visibility
- **AND** deferred attempts SHALL honor `next_attempt_at` without inventing a free retry

---

### Requirement: Stage-local terminalization SHALL NOT bypass the recovery ledger

Stage code paths SHALL NOT transition an item to `pipeline:needs-human` (or equivalent human hold)
based solely on locally inferred review recurrence, ceiling counts, or exhausted stage markers when
the durable recovery ledger and supervisor would still own a recoverable path. Review non-
convergence remains engine-owned through the `review-findings` class and controller recipes already
specified by this capability.

#### Scenario: Local recurrence inference does not short-circuit the controller

- **WHEN** a stage observes recurrence or ceiling evidence for current findings
- **AND** the autonomous recovery controller still has a permitted recoverable recipe or unconsumed
  budget for the projected class
- **THEN** the stage SHALL NOT apply a human hold solely from that local inference
- **AND** SHALL surface recovery-bound diagnostics for controller reconcile
