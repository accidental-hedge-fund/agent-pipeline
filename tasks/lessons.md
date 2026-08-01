# Lessons

- When several stage failures all become `blocked`, inspect the outer supervisor before adding
  stage-local retries. A configured recovery policy with untouched budgets is evidence that the
  orchestration contract is dead or bypassed.
- A human hold requires an explicit authority boundary or product decision. Mechanical validation,
  merge, worktree, harness, CI, and state-reconciliation failures must remain engine-owned through
  bounded recovery and typed exhaustion.
- Use incident failures as fixtures for a generic recovery taxonomy and controller. Do not encode
  provider names or individual issue numbers into production recovery behavior.
- A validated retry/backoff configuration is not an implemented recovery policy until production
  actually executes it through an injected, testable wait seam.
- Persisted recovery claims must be bound to freshly observed candidate identity both before and
  after the side effect; a completed local action is not success until the remote head proves it.
- Recovery backoff is scheduler state, not an item-executor sleep. Persist the eligibility deadline,
  run independent siblings first, and let only an otherwise-idle driver wait while maintaining its heartbeat.
- Candidate-bound human authority expires when fresh reconciliation observes another HEAD; a label
  cannot preserve authority granted for stale reviewed evidence.
- A green broad suite does not replace adversarial lifecycle review. Explicitly test crashes after
  each external side effect and fresh external truth that overtakes a durable local claim.
