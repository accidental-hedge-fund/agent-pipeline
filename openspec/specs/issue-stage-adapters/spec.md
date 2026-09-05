# issue-stage-adapters Specification

## Purpose
Makes every issue-advancement stage a RecoverySupervisor operation adapter so stages report observations and evidence while RecoverySupervisor owns reconciliation, treatment, Cooling, and re-entry.

## Requirements

### Requirement: Every issue-advancement stage SHALL act as a typed operation adapter

Every delivery stage in `STAGES` from `planning` through `ready-to-deploy` SHALL act as a RecoverySupervisor operation adapter. The adapter SHALL perform one bounded attempt and SHALL report a typed operation observation with side-effect certainty, candidate binding, and ingress evidence through the existing RecoverySupervisor observation sink. The adapter SHALL NOT choose Cooling, wait, typed request, cancellation, or a terminal mechanical outcome. RecoverySupervisor SHALL remain the sole lifecycle owner. `backlog` and `needs-spec` remain admission waits and SHALL NOT become delivery adapters.

#### Scenario: Planning reports an observation and does not terminalize

- **WHEN** the planning adapter completes one bounded attempt that fails mechanically (exception, timeout, nonzero harness exit, or uncertain side effect)
- **THEN** it SHALL emit a typed operation observation
- **AND** it SHALL NOT mark the Logical Operation complete, cancelled, or human-owned
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Adapter that chooses treatment fails the contract

- **WHEN** a contract test inspects an issue-advancement stage adapter
- **AND** that adapter selects Cooling, wait, typed request, cancellation, or a terminal mechanical outcome
- **THEN** the contract test SHALL fail
- **AND** SHALL name the stage

#### Scenario: Admission waits are not delivery adapters

- **WHEN** the current stage is `backlog` or `needs-spec`
- **THEN** the orchestrator SHALL NOT require a delivery-stage adapter invocation
- **AND** SHALL NOT start planning or implementation

---

### Requirement: Every delivery-stage adapter SHALL declare its operation invariants

Each delivery-stage adapter SHALL declare the relevant operation invariant for its attempt:
precondition, postcondition, authoritative observer, candidate binding, side-effect identity, safe
replay predicate, and reconstruction rule. A process exit, exception, timeout, or model response
SHALL be ingress evidence, not success by itself. Verified completion SHALL require the declared
observer to prove the postcondition for the bound candidate and side-effect identity. The adapter
SHALL observe that invariant before any local transport retry.

#### Scenario: Missing invariant fails the contract

- **WHEN** a delivery stage from `planning` through `ready-to-deploy` has no declared operation invariant
- **THEN** a contract test SHALL fail and name that stage

#### Scenario: Missing reconstruction rule fails the contract

- **WHEN** a delivery stage from `planning` through `ready-to-deploy` omits side-effect identity, safe replay predicate, or reconstruction rule
- **THEN** a contract test SHALL fail and name that stage

#### Scenario: Exit zero is not verified completion

- **WHEN** a stage adapter process exits 0
- **AND** the authoritative observer has not proven the postcondition for the bound candidate
- **THEN** the observation SHALL NOT mark the Logical Operation complete
- **AND** side-effect certainty SHALL NOT be `known_complete` solely because of the exit code

#### Scenario: Successful first attempt still requires observer proof

- **WHEN** the first adapter attempt exits 0
- **THEN** the adapter SHALL observe the declared postcondition
- **AND** SHALL return verified success only when side-effect certainty is `known_complete`
- **AND** SHALL keep an `uncertain` result as owned cooling
- **AND** SHALL replay only after a `known_absent` observation under the same identity and budget

#### Scenario: Adapter observes before local retry

- **WHEN** a delivery-stage adapter is about to retry a proven-idempotent transport operation
- **THEN** it SHALL observe the declared invariant first
- **AND** SHALL NOT retry when side-effect certainty is `known_complete` or `uncertain`

#### Scenario: Observed completion is verified success of the original operation

- **WHEN** a local attempt fails or times out
- **AND** the observer then proves side-effect certainty `known_complete`
- **THEN** the retry result SHALL complete as verified success on the original Logical Operation
- **AND** SHALL NOT return the failed attempt as the final result
- **AND** SHALL NOT replay the mutation

#### Scenario: Uncertain observation stays owned cooling

- **WHEN** a local attempt fails or times out
- **AND** the observer reports side-effect certainty `uncertain`
- **THEN** the retry result SHALL be an owned cooling or external-condition wait outcome
- **AND** SHALL NOT replay
- **AND** SHALL NOT treat the original failed attempt as the final ordinary failure

### Requirement: Stage-local loops SHALL be bounded transport retry only

A stage adapter MAY retry a transport operation locally only when all of the following hold: the retried operation is proven idempotent, side-effect certainty is `known_absent`, the retry remains inside the adapter attempt deadline, and the candidate epoch has not changed. Candidate movement, uncertain side effects, treatment changes, Cooling, and re-entry SHALL belong to RecoverySupervisor. Existing `gh` transient retry and `git worktree add` config-lock retry MAY remain as transport retry. Stage-local crash-retry, auto-recovery-cap, rematerialize-then-block, and review-non-convergence loops SHALL NOT remain lifecycle policy.

#### Scenario: Transient gh retry is allowed as transport retry

- **WHEN** a stage adapter performs an idempotent `gh` read or a proven-absent write
- **AND** the error is a classified transient transport failure
- **AND** the attempt deadline has not expired
- **THEN** the existing `gh` transient retry MAY run inside the adapter attempt
- **AND** RecoverySupervisor SHALL still receive one observation for the attempt if the retry exhausts or succeeds

#### Scenario: Crash retry after uncertain side effect is forbidden

- **WHEN** a harness invocation fails with uncertain side-effect certainty
- **THEN** the stage adapter SHALL NOT re-invoke the harness as lifecycle policy
- **AND** it SHALL report the observation and return
- **AND** a fixture that retries locally SHALL fail a contract test

#### Scenario: Candidate movement forbids local retry

- **WHEN** the candidate identity changes during an adapter attempt
- **THEN** the adapter SHALL NOT retry against the prior candidate
- **AND** RecoverySupervisor SHALL own reconciliation for the new epoch

---

### Requirement: Candidate replacement SHALL invalidate candidate-bound evidence

Candidate movement SHALL start a new candidate epoch. Review verdicts, test results, eval results, shipcheck results, decisions, and authority holds bound to the prior epoch SHALL be invalid for the new candidate. RecoverySupervisor SHALL require those facts to be re-proven against the new candidate before they may gate advancement.

#### Scenario: New HEAD invalidates prior review verdict

- **WHEN** the candidate HEAD SHA changes after a review verdict was recorded
- **THEN** that verdict SHALL NOT authorize advancement at the new HEAD
- **AND** RecoverySupervisor SHALL treat the prior verdict as invalid for the new epoch

#### Scenario: Authority hold does not survive candidate replacement

- **WHEN** a human-authority hold was bound to candidate SHA `A`
- **AND** fresh reconciliation observes candidate SHA `B`
- **THEN** the hold SHALL NOT remain authoritative for SHA `B`
- **AND** a remaining `pipeline:blocked` label SHALL NOT preserve the stale authority

---

### Requirement: Harness crash, malformed output, no-op, and non-convergence SHALL be owned observations

A harness crash, timeout, malformed or contract-failing output, clean no-new-commit with an unsatisfied goal, and review non-convergence SHALL each produce a typed operation observation. RecoverySupervisor MAY advance treatment or enter Cooling. The adapter SHALL NOT mark the Logical Operation complete, cancelled, or human-owned for those faults. A genuine current `human-decision-required` diagnostic with current candidate-bound authority evidence MAY still project a park.

#### Scenario: Harness crash stays owned

- **WHEN** an implementer or reviewer harness exits nonzero or times out
- **THEN** the stage adapter SHALL emit an observation
- **AND** the Logical Operation SHALL remain owned
- **AND** the adapter SHALL NOT call `setBlocked` as lifecycle terminal

#### Scenario: Malformed review output stays owned

- **WHEN** reviewer stdout cannot be parsed into a schema-satisfying verdict after the shared format-repair policy
- **THEN** the gated side effect SHALL NOT run
- **AND** the adapter SHALL emit an observation
- **AND** the Logical Operation SHALL remain owned

#### Scenario: Unsatisfied no-op stays owned

- **WHEN** a harness round produces no new commit
- **AND** salvage creates no commit
- **AND** the stage goal check reports unsatisfied
- **THEN** the adapter SHALL emit an observation for that no-op
- **AND** SHALL NOT treat the round as silent success
- **AND** SHALL NOT mark the Logical Operation complete or cancelled

#### Scenario: Review non-convergence stays owned

- **WHEN** a review round hits its adversarial ceiling with residual blocking findings
- **THEN** the adapter SHALL emit an observation
- **AND** RecoverySupervisor MAY project `needs-human` as a compatibility park
- **AND** the Logical Operation SHALL remain owned unless a genuine current authority request exists

---

### Requirement: Quality gates SHALL remain fully enforced after adapter migration

Tests, review, OpenSpec validation, visual, eval, and shipcheck gates SHALL still run on the bound candidate and SHALL still refuse advancement when they fail. Adapter migration SHALL NOT skip, default-disable, or demote those gates. A gate failure SHALL be an observation plus a compatibility projection. It SHALL NOT be a skipped check.

#### Scenario: Eval gate still refuses advancement

- **WHEN** `eval_gate.enabled` is true and the eval command fails
- **THEN** the eval adapter SHALL NOT advance toward `ready-to-deploy`
- **AND** SHALL emit an observation
- **AND** SHALL NOT skip the gate because RecoverySupervisor owns treatment

#### Scenario: OpenSpec invalid still refuses advancement

- **WHEN** OpenSpec validation fails for the active change
- **THEN** the owning adapter SHALL NOT treat the tree as valid for downstream implement or archive
- **AND** SHALL emit an observation

---

### Requirement: Former issue-stage blocking sites SHALL have explicit migrated outcomes

Every production issue-stage site that previously blocked an issue, parked at `needs-human`, or otherwise escalated out of normal advance SHALL have an explicit migrated outcome recorded in the escalation inventory: the observation class, the RecoverySupervisor treatment, and whether a blocked or `needs-human` label is still projected. A new issue-stage emitter without a migrated-outcome row SHALL fail the disposition drift guard.

#### Scenario: Missing migrated outcome fails the guard

- **WHEN** a production issue-stage `setBlocked` or equivalent park emitter is added without a migrated-outcome row
- **THEN** the drift-guard test SHALL fail
- **AND** the failure SHALL identify the site

#### Scenario: Mechanical site does not migrate to human authority

- **WHEN** a former issue-stage blocking site is a mechanical fault (worktree, harness crash, transport, capacity)
- **THEN** its migrated outcome SHALL NOT be a genuine human-authority request
- **AND** RecoverySupervisor SHALL retain ownership as Cooling or an external-condition wait
