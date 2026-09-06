## ADDED Requirements

### Requirement: Pipeline SHALL bind or reproduce current-SHA Tester evidence after PR-backed trusted-surface resolution

After an implementation commit is pushed and a linked pull request makes the candidate and trusted-surface identity observable, the pipeline SHALL bind or reproduce SHA-matched Tester evidence for the final pushed PR head with the required implementation role and a well-formed readiness `evidence_subject` before the first consumer delivery-stage evidence observer runs. Ordinary advance, nested advance, `single`, `loop`, and FRG SHALL share this path. The bound or reproduced `candidate_sha` SHALL equal the final pushed PR head as a full 40-character hex SHA. The pipeline SHALL NOT treat pre-push SHA, a different candidate SHA, or blocked trusted-surface evidence as current implementation-role Tester evidence for that consumer stage.

When SHA-matched Tester evidence already exists for that final PR head and records a suite pass, and trusted-surface for that SHA is `passthrough` or `rebound` with a trustworthy verifier pin, the pipeline SHALL bind the subject and implementation role onto that record. The pipeline SHALL NOT require a second suite command solely to emit the subject. When no SHA-matched record exists for that head, or the record is stale or malformed for that head, the pipeline SHALL reproduce evidence through the existing deterministic producer and persist the subject and implementation role.

#### Scenario: subject-less Tester after test-gate-before-PR is rebound before design-gate observer

- **WHEN** implementing runs the test gate before a pull request exists
- **AND** Tester evidence is written for candidate SHA S without a readiness `evidence_subject` because trusted-surface was not yet candidate-observable
- **AND** implementing then pushes S and opens a linked pull request whose head is S
- **AND** trusted-surface for S then resolves `passthrough` or `rebound`
- **THEN** the pipeline SHALL bind or reproduce SHA-matched Tester evidence for S with implementation role and a well-formed `evidence_subject`
- **AND** that bind or reproduce SHALL complete before the first consumer delivery-stage evidence observer runs
- **AND** the next delivery stage SHALL NOT refuse with `required implementation evidence role, observed missing` solely because the pre-PR record omitted the subject

#### Scenario: bind uses the final pushed PR head and does not re-run a matching suite

- **WHEN** SHA-matched Tester evidence for PR head S already records a suite pass
- **AND** trusted-surface for S is `passthrough` or `rebound` with a trustworthy verifier pin
- **THEN** the pipeline SHALL bind `evidence_subject` and implementation role onto that record for S
- **AND** SHALL NOT require a second suite command solely because the earlier write omitted the subject
- **AND** `candidate_sha` SHALL equal S

#### Scenario: reproduce when the final PR head has no current Tester record

- **WHEN** the final pushed PR head is S
- **AND** no SHA-matched current Tester record exists for S (missing, stale, or malformed)
- **AND** trusted-surface for S is `passthrough` or `rebound`
- **THEN** the pipeline SHALL run the existing deterministic Tester producer for S
- **AND** SHALL persist SHA-matched Tester evidence for S with implementation role and a well-formed `evidence_subject`

#### Scenario: pre-push or stale SHA is not blessed

- **WHEN** Tester evidence exists only for SHA A
- **AND** the final pushed PR head is SHA B where A ≠ B
- **THEN** the pipeline SHALL NOT present the A record as current implementation-role evidence for B
- **AND** SHALL bind or reproduce evidence for B before a consumer delivery-stage observer runs
- **OR** SHALL fail closed with a typed actionable blocker if B cannot be observed

#### Scenario: blocked trusted-surface is not rebound as a readiness pass

- **WHEN** trusted-surface for the final PR head remains `blocked` or has no trustworthy verifier pin
- **THEN** the pipeline SHALL NOT emit a fabricated readiness `evidence_subject`
- **AND** SHALL NOT treat the subject-less record as consumer-stage implementation-role proof
- **AND** SHALL fail closed with a typed actionable blocker rather than invent passthrough

#### Scenario: ordinary advance, nested advance, single, loop, and FRG share the path

- **WHEN** any of ordinary advance, nested advance, `single`, `loop`, or FRG reaches a consumer delivery stage after implementing has pushed a linked PR
- **THEN** that invocation SHALL use the same bind-or-reproduce path
- **AND** SHALL NOT skip the bind because the caller is FRG or nested

#### Scenario: disabled test gate does not strand exact product-path implementation proof

- **WHEN** `test_gate.enabled` is false
- **AND** no SHA-matched passed Tester record exists for the final PR head
- **AND** exact product-path implementation proof exists for the observed candidate
- **THEN** the pipeline SHALL NOT fail closed solely because Tester rebind cannot record a suite pass
- **AND** the consumer observer SHALL still accept that exact product-path implementation proof

#### Scenario: successor dispatch reuses SHA-matched rebound Tester evidence from a prior run

- **WHEN** recovery or a prior advance bound SHA-matched passed Tester evidence for PR head S in a prior run directory
- **AND** the next loop dispatch mints a new run directory
- **THEN** the pipeline SHALL bind or adopt that SHA-matched record into the successor run by exact candidate identity
- **AND** SHALL NOT require a second suite command solely to recreate the already-passed record

#### Scenario: PR head movement after bind is not authorized as the observed candidate

- **WHEN** the pipeline binds or reproduces Tester evidence for observed PR head S1
- **AND** a subsequent read of the linked PR head observes S2 where S1 ≠ S2 before the consumer observer runs
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **OR** SHALL rebind or reproduce for S2 before the observer runs
- **AND** SHALL NOT present S1 Tester evidence as current implementation-role proof for S2

#### Scenario: enabled test gate later-stage resume without worktree fails closed

- **WHEN** `test_gate.enabled` is true
- **AND** a later consumer implementation stage resumes with no managed worktree
- **AND** no SHA-matched passed Tester record exists for the final PR head
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT dispatch the consumer delivery-stage observer
- **AND** SHALL NOT return helper action `not-applicable`

#### Scenario: PR head movement after confirmation is detected at the observer

- **WHEN** bind and a confirmation read observed PR head S1
- **AND** a managed worktree HEAD remains S1
- **AND** the consumer observer's live PR read observes S2 where S1 ≠ S2
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **OR** SHALL rebind or reproduce for S2 before treating the observation as proven
- **AND** SHALL NOT present S1 worktree HEAD or S1 Tester evidence as implementation-role proof for S2

#### Scenario: PR head movement after execution is a typed mismatch, not a generic wait

- **WHEN** bind and the pre-attempt observer observed PR head S1
- **AND** the consumer stage executes
- **AND** the post-attempt observer's live PR read observes S2 where S1 ≠ S2
- **AND** the S1→S2 movement is not a stage-owned push from that consumer's managed worktree
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **AND** SHALL NOT leave the outcome as generic Candidate-binding-changed waiting
- **AND** SHALL restore the consumer stage label, or persist typed blocker `tester_rebind_stage_label_unrestored` if that restoration cannot be confirmed
- **AND** SHALL NOT record `stage_complete` as `advanced` for that consumer stage
- **AND** recovery SHALL NOT treat `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` as eligible for that diagnostic

#### Scenario: stage-owned PR head mutation is rebound, not foreign drift

- **WHEN** bind and the pre-attempt observer observed PR head S1
- **AND** the consumer stage is `fix-1`, `fix-2`, or `pre-merge`
- **AND** that stage pushes a new PR head S2 from the managed worktree
- **AND** the post-attempt observer's live PR read observes S2 where S1 ≠ S2
- **AND** the managed worktree HEAD equals S2
- **THEN** the pipeline SHALL re-resolve trusted-surface and bind or reproduce Tester evidence for S2
- **AND** SHALL NOT fail closed with `tester_rebind_pr_head_mismatch` solely because the stage produced S2
- **AND** SHALL NOT restore the consumer stage label
- **AND** SHALL allow the handler outcome to stand when S2 binding succeeds

#### Scenario: failed restoration of the consumer stage label is a typed reconciliation blocker

- **WHEN** post-attempt unowned PR-head movement requires restoring the consumer stage label
- **AND** the compensating transition does not confirm the original consumer stage label
- **THEN** the pipeline SHALL persist typed blocker `tester_rebind_stage_label_unrestored`
- **AND** SHALL NOT silently discard the restoration failure
- **AND** SHALL NOT record `stage_complete` as `advanced` for that consumer stage

#### Scenario: disabled-gate exact-proof still fail-closes when PR head moved

- **WHEN** `test_gate.enabled` is false
- **AND** the helper reports `ok: true` with action `not-applicable`
- **AND** bind observed PR head S1
- **AND** a subsequent read of the linked PR head observes S2 where S1 ≠ S2 before the consumer observer treats the observation as proven
- **THEN** the pipeline SHALL fail closed with typed blocker `tester_rebind_pr_head_mismatch`
- **AND** SHALL NOT treat worktree S1 changed paths as exact implementation proof for S2

### Requirement: Pipeline SHALL fail closed when PR head or trusted-surface identity cannot be observed after push

If, after the implementation commit is pushed, the linked PR head is missing, is not a full 40-character hex SHA, or disagrees with the pushed head, or trusted-surface identity cannot be resolved, the pipeline SHALL fail closed with a typed actionable blocker. The pipeline SHALL NOT run a consumer delivery-stage observer against missing implementation-role evidence as if the post-PR bind had succeeded. This fail-closed rule SHALL apply at every consumer implementation stage, including `design-gate`, `review-1`, `fix-1`, and `pre-merge`. The blocker code SHALL be machine-readable on the observation or run evidence and SHALL NOT be only the generic `required implementation evidence role, observed missing` string.

#### Scenario: missing PR head after push is a typed blocker

- **WHEN** implementing reports a successful push
- **AND** no linked pull request head SHA can be observed as a full 40-character hex value
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT enter the next consumer delivery stage as verified
- **AND** SHALL NOT invent a candidate SHA or `evidence_subject`

#### Scenario: unobservable trusted-surface after push is a typed blocker

- **WHEN** a linked PR head S is observable
- **AND** trusted-surface for S cannot be resolved to `passthrough` or `rebound` with a trustworthy verifier pin
- **THEN** the pipeline SHALL persist a typed actionable blocker
- **AND** SHALL NOT bind a fabricated subject onto Tester evidence for S

#### Scenario: later consumer stages fail closed on typed rebind failure

- **WHEN** the shared bind-or-reproduce path returns a typed failure at `review-1`, `fix-1`, or `pre-merge`
- **THEN** the pipeline SHALL fail closed with that typed actionable blocker
- **AND** SHALL NOT dispatch the consumer delivery-stage observer
- **AND** SHALL NOT replace the typed blocker with generic `required implementation evidence role, observed missing`

### Requirement: Post-PR Tester rebind regressions SHALL fail the unit suite

Automated tests covered by `npm run ci` SHALL inject I/O (no live network, git, or subprocess) and SHALL fail if: (1) a fixture where the test gate passes before PR creation, Tester omits `evidence_subject`, then the same SHA resolves trusted-surface `passthrough` or `rebound` still lets the next consumer delivery stage refuse `required implementation evidence role, observed missing`; (2) rebound or reproduced Tester evidence uses a pre-push SHA, a stale SHA, or a blocked trusted-surface fabricated subject; (3) a missing PR head or unresolvable trusted-surface after push does not produce a typed actionable blocker.

#### Scenario: design-gate missing-role refuse after same-SHA passthrough fails the suite

- **WHEN** a unit test drives implementing test-gate-before-PR (subject omitted), then PR creation, then same-SHA trusted-surface `passthrough` or `rebound`, then the next consumer delivery-stage observer
- **THEN** the test SHALL fail unless that observer receives implementation-role Tester evidence for the final PR head
- **AND** the test SHALL inject I/O and SHALL NOT perform live network, git, or subprocess calls

#### Scenario: stale or blocked rebound fails the suite

- **WHEN** a unit test supplies Tester evidence for SHA A or a blocked trusted-surface decision and asks the rebind path to satisfy consumer evidence for SHA B or a blocked surface
- **THEN** the test SHALL fail if the path reports current implementation-role evidence
