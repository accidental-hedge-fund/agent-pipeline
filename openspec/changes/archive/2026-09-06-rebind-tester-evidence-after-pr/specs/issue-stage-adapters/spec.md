## ADDED Requirements

### Requirement: Consumer delivery-stage observers SHALL accept rebound Tester evidence as implementation-role proof

A consumer delivery stage that requires the `implementation` evidence role (including `design-gate` and later non-producer stages) SHALL treat SHA-matched Tester evidence as proving that role when all of the following hold: the artifact `candidate_sha` equals the observed candidate SHA (final pushed PR head), the artifact carries a well-formed `evidence_subject`, and the artifact identifies the implementation role. Exact product-path implementation proof SHALL remain sufficient. The adapter SHALL still refuse planning-role artifacts, subject-less Tester records, SHA-mismatched records, and inferences from process exit, labels, comments, or PR merge state alone. `completingEvidenceBindingFailure` SHALL remain in force.

The bind or reproduce of that Tester evidence SHALL complete before the consumer adapter's first evidence observer runs. The observer SHALL NOT refuse with `required implementation evidence role, observed missing` solely because the pre-PR Tester write omitted `evidence_subject` when a same-SHA post-PR bind has already produced implementation-role evidence.

#### Scenario: design-gate observes rebound implementation-role Tester evidence

- **WHEN** SHA-matched Tester evidence for PR head S carries a well-formed `evidence_subject` and implementation role
- **AND** trusted-surface for S is `passthrough` or `rebound`
- **AND** the current stage is a consumer delivery stage that requires `implementation`
- **THEN** the pre-attempt evidence observer SHALL report `evidenceRole` `implementation` bound to S
- **AND** SHALL NOT return `required implementation evidence role, observed missing`

#### Scenario: subject-less or SHA-mismatched Tester is not implementation proof

- **WHEN** Tester evidence omits `evidence_subject` or its `candidate_sha` is not the observed candidate SHA
- **THEN** the consumer observer SHALL NOT treat that record as implementation-role proof
- **AND** binding SHALL still fail closed unless exact product-path implementation proof exists for the observed SHA

#### Scenario: planning-role artifacts still cannot complete an implementation consumer stage

- **WHEN** the consumer observer sees only planning-role evidence for the bound candidate
- **THEN** it SHALL report the implementation postcondition as unproved
- **AND** SHALL NOT advance as verified completion

#### Scenario: binding rules are not weakened

- **WHEN** a consumer delivery-stage adapter observes evidence before execution
- **AND** the observed role is missing, planning, or SHA/epoch-mismatched
- **AND** no valid rebound implementation-role Tester evidence exists for the observed SHA
- **THEN** the adapter SHALL still refuse before execution
- **AND** RecoverySupervisor SHALL retain ownership

### Requirement: Delivery-stage adapter SHALL accept a stage-owned successor Candidate without reporting S1 as S2 proof

The delivery-stage adapter SHALL permit a handler outcome at `fix-1`, `fix-2`, or `pre-merge` when the post-attempt observer reports proven implementation-role evidence for S2 and the caller supplies that S2 snapshot as stage-owned successor evidence. The adapter SHALL record S2 as the completion Candidate. The adapter SHALL NOT represent the pre-attempt S1 binding as S2 proof. A Candidate SHA change without matching producer-completion evidence or matching stage-owned successor evidence SHALL still wait as Candidate-binding-changed.

#### Scenario: stage-owned successor binding records S2 proof

- **WHEN** the consumer stage is `fix-1`, `fix-2`, or `pre-merge`
- **AND** the pre-attempt observer bound Candidate S1
- **AND** the post-attempt observer reports proven implementation-role evidence for S2
- **AND** the caller supplies that S2 snapshot as stage-owned successor evidence
- **THEN** the adapter SHALL allow the handler outcome to stand
- **AND** SHALL record S2 as the completion Candidate
- **AND** SHALL NOT represent the pre-attempt S1 binding as S2 proof

#### Scenario: Candidate SHA change without stage-owned successor evidence still waits

- **WHEN** the post-attempt observer Candidate SHA differs from the pre-attempt SHA
- **AND** no producer-completion evidence matches the post-attempt proof
- **AND** no stage-owned successor evidence matches the post-attempt proof
- **THEN** the adapter SHALL return waiting for Candidate-binding-changed
- **AND** RecoverySupervisor SHALL retain ownership
