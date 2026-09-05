## MODIFIED Requirements

### Requirement: implementing stage is resumable when commits exist in the worktree

When the orchestrator dispatches stage `implementing` at the start of a run, it SHALL first consult the repo-stable live-planning marker for the issue. If a live process owns the marker, the dispatcher SHALL return a `waiting` outcome naming that owner without inspecting or mutating the worktree. Otherwise it SHALL reconcile durable harness mutation ownership and the current candidate epoch before deciding whether implementation is complete.

Commits ahead of base SHALL be provenance only. The dispatcher SHALL resume the post-implementation sequence only when the shared implement-deliverable observer proves the exact current candidate contains the required product implementation and identifies that evidence as implementation rather than planning. A planning artifact, planning-only salvage or checkpoint commit, merged planning/specification PR, process exit, local ledger state, label, or comment SHALL NOT satisfy that proof. When product implementation is not proved and the worktree can be safely reused, RecoverySupervisor SHALL retain ownership and schedule or invoke the implementation harness for the current epoch. Unknown product dirt and failed ownership checkpointing SHALL retain their existing fail-closed behavior. When no reusable candidate exists, RecoverySupervisor MAY reconstruct the stage through the established restart-from-ready treatment.

#### Scenario: re-entry with commits — advances to review-1

- **WHEN** a pipeline run re-enters `implementing` with no live owner
- **AND** the exact current candidate is ahead of base and authoritatively satisfies the product implementation postcondition
- **AND** ownership reconciliation and cleanliness checks pass
- **THEN** the pipeline SHALL run the required post-implementation gates and publication sequence
- **AND** SHALL NOT re-run planning or implementation solely to manufacture another commit

#### Scenario: reused implementation PR is bound to the admitted operation

- **WHEN** the publication sequence reuses an existing or concurrently created implementation PR
- **THEN** it SHALL verify the PR body is bound to the admitted Logical Operation
- **AND** when the binding is absent it SHALL append the marker and confirm it by re-reading the PR
- **AND** a conflicting or unconfirmed binding SHALL remain RecoverySupervisor-owned and SHALL NOT transition toward review

#### Scenario: Planning-only commit invokes implementation

- **WHEN** a salvaged or ordinary commit ahead of base contains only the accepted OpenSpec or other planning artifact
- **AND** no exact-candidate product implementation postcondition is proved
- **THEN** the pipeline SHALL NOT resume post-implementation, open an implementation PR, or transition to design or review
- **AND** RecoverySupervisor SHALL retain ownership and invoke or schedule the implementation harness

#### Scenario: re-entry with a live owner — returns waiting (no resume race)

- **WHEN** the repo-stable live-planning marker records a live owner for the issue
- **THEN** the dispatcher SHALL return an owned `waiting` outcome
- **AND** SHALL NOT inspect the worktree, resume post-implementation, roll back the label, or restart planning

#### Scenario: Unknown product dirt stays fail closed

- **WHEN** ownership reconciliation leaves unknown product dirt on the candidate
- **THEN** the dispatcher SHALL NOT invoke a product-mutating harness or enter post-implementation publication
- **AND** RecoverySupervisor SHALL retain the existing typed recovery ownership

#### Scenario: resume after unblock — test gate re-runs

- **WHEN** a prior implementing attempt was blocked by the test gate
- **AND** the exact current candidate now has authoritative implementation-role proof and the operator clears the compatibility block
- **THEN** re-entry SHALL run the test gate again before publication
- **AND** SHALL advance only when the current Candidate epoch passes

#### Scenario: resume when gate still fails — re-blocks

- **WHEN** implementing re-entry has authoritative current implementation proof
- **AND** the test gate still fails
- **THEN** the pipeline SHALL report the established test-gate failure under RecoverySupervisor ownership
- **AND** SHALL NOT open a PR or transition toward review

## REMOVED Requirements

### Requirement: Implementing re-entry SHALL adopt an existing planning deliverable when the implement goal is already satisfied

**Reason**: A planning deliverable proves specification work, not product implementation. Treating its presence as the implementing-stage goal caused planning-only recovery to skip implementation.

**Migration**: Preserve the planning artifact as role-typed provenance and require the replacement exact-candidate implementation postcondition before post-implementation gates or publication.

## ADDED Requirements

### Requirement: Planning and implementation deliverables SHALL have distinct identities

The pipeline SHALL record or derive a verifiable role and identity for the accepted planning artifact and a separate identity for the implementation candidate. Implementing-stage goal checks SHALL accept only implementation-role evidence bound to the current Candidate epoch. A content match, commit authorship marker, or OpenSpec change path SHALL NOT change a planning artifact into implementation evidence.

#### Scenario: Salvage preserves planning role

- **WHEN** recovery salvages a commit whose material product delta is only the planning artifact
- **THEN** the salvaged commit SHALL remain classified as planning provenance
- **AND** SHALL NOT satisfy the implementing-stage goal

#### Scenario: Candidate replacement requires new implementation proof

- **WHEN** implementation was proved for candidate epoch `E1`
- **AND** the candidate moves to epoch `E2`
- **THEN** the prior implementation proof SHALL be invalid for `E2`
- **AND** post-implementation work SHALL wait until the implementation postcondition is re-proved for `E2`
