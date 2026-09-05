## MODIFIED Requirements

### Requirement: The engine SHALL publish a matching commit through the existing post-implement path

When the unpublished-stage classifier matches and the shared implement-deliverable observer authoritatively proves that the exact current candidate satisfies the product implementation postcondition, the engine SHALL run the existing post-implementation sequence: format and test gates, then push the managed branch without force-push, then create or find the implementation PR with the established issue-closing reference, then transition `implementing → review-1` through engine-owned state. The proof SHALL identify the implementation candidate and Candidate epoch and SHALL be distinct from planning-artifact identity. The engine SHALL NOT skip those gates or substitute a planning artifact, planning-only salvage/checkpoint commit, process result, label, comment, ledger entry, or merged planning PR for implementation proof. The same recipe identity `publish_unpublished_stage_commit` SHALL remain shared by same-process timeout, autonomous recovery, and `recover-parked`.

When exact-candidate implementation is not proved, the engine SHALL NOT publish to `review-1`. RecoverySupervisor SHALL retain durable ownership and select implementation re-entry, reconstruction, cooling, an external wait, or a valid typed request under existing policy.

#### Scenario: Validated unpublished commit reaches review-1

- **WHEN** the unpublished-stage classifier matches
- **AND** the exact current candidate's product implementation postcondition is authoritatively proved
- **AND** format and test gates pass
- **AND** push and PR creation succeed
- **THEN** the engine SHALL open or reuse the implementation PR and transition to `review-1`
- **AND** SHALL retain the existing non-force and issue-linking invariants

#### Scenario: Planning-only salvage is not published as implementation

- **WHEN** a timeout leaves a publishable-authorship salvage or checkpoint commit
- **AND** its material delta is only a planning or specification artifact
- **THEN** the engine SHALL NOT enter format/test publication as completed implementation
- **AND** SHALL NOT create an implementation PR or transition to `review-1`
- **AND** RecoverySupervisor SHALL resume or schedule implementation work

#### Scenario: Failing test gate does not open a PR

- **WHEN** the classifier matches and current implementation proof exists
- **AND** the test gate exits non-zero
- **THEN** the engine SHALL report the established test-gate failure under RecoverySupervisor ownership
- **AND** SHALL NOT create a PR or transition to `review-1`

#### Scenario: Incomplete implement is not published to review-1

- **WHEN** a timeout left a salvage or checkpoint commit
- **AND** exact-candidate implementation proof is absent or unsatisfied
- **THEN** the engine SHALL NOT create a PR solely to recover the timeout
- **AND** SHALL NOT transition to `review-1`
- **AND** RecoverySupervisor SHALL retain the incomplete implementing work

#### Scenario: Production publish requires the implement-deliverable probe

- **WHEN** the production publish executor lacks the authoritative implementation-candidate observer
- **THEN** it SHALL refuse gates, push, PR creation, and transition
- **AND** the admitted operation SHALL remain durably owned

#### Scenario: Force-push is refused

- **WHEN** the publish recipe runs for a proved implementation candidate
- **THEN** the engine SHALL use the existing non-force, currency-checked push path
- **AND** SHALL NOT use force-push or force-with-lease

#### Scenario: Candidate movement invalidates publish proof

- **WHEN** implementation proof was recorded for candidate epoch `E1`
- **AND** HEAD moves to candidate epoch `E2` before publication
- **THEN** publication SHALL be refused until implementation and required gates are re-proved for `E2`
