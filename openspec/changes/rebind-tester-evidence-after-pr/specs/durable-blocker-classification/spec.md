## ADDED Requirements

### Requirement: Recovery SHALL NOT spend scratch or publish recipes on post-PR Tester evidence-ordering

When a consumer delivery stage refuses with missing implementation-role evidence after a linked PR exists and trusted-surface for that SHA is `passthrough` or `rebound` (or after SHA-matched Tester evidence omitted `evidence_subject` only because trusted-surface was not yet candidate-observable), the engine SHALL classify that diagnostic as a deterministic evidence-ordering case under existing `workflow-engine-defect`. Recovery SHALL apply the shared Tester bind-or-reproduce recipe for that diagnostic. Recovery SHALL NOT claim or charge `unlink_engine_scratch`, `checkpoint_owned_harness_dirt`, or `publish_unpublished_stage_commit` for that diagnostic. Those three recipes SHALL be recorded as inapplicable skips and SHALL NOT consume a later strategy bound. Classification SHALL use structured diagnostic or evidence fields, not harness name, issue labels, or free-form prose.

The engine SHALL NOT add a new `DurableBlockerClass` for this case. The engine SHALL NOT treat this diagnostic as human authority. If PR head or trusted-surface identity still cannot be observed, the typed fail-closed blocker from Tester rebind SHALL apply; recovery SHALL NOT invent a subject or skip delivery-stage binding. Recovery SHALL NOT treat a helper `not-applicable` result as a repaired blocker, and SHALL NOT clear `pipeline:blocked` unless bind or reproduce produced current-SHA implementation-role Tester evidence.

#### Scenario: scratch and publish are not charged for the evidence-ordering refuse

- **WHEN** durable recovery sees a consumer-stage refuse `required implementation evidence role, observed missing`
- **AND** a linked PR head S exists
- **AND** trusted-surface for S is `passthrough` or `rebound`, or SHA-matched Tester evidence for S omitted `evidence_subject` only because trusted-surface was not yet observable at produce time
- **THEN** recovery SHALL NOT start or charge `unlink_engine_scratch`
- **AND** SHALL NOT start or charge `checkpoint_owned_harness_dirt`
- **AND** SHALL NOT start or charge `publish_unpublished_stage_commit`
- **AND** SHALL claim the shared Tester bind-or-reproduce recipe when that recipe has remaining budget

#### Scenario: inapplicable scratch is a skip, not a spent success

- **WHEN** the evidence-ordering diagnostic is active
- **AND** a recovery policy list still includes scratch or publish recipes for `workflow-engine-defect`
- **THEN** those recipes SHALL be recorded as inapplicable skips for this diagnostic
- **AND** SHALL NOT consume the evidence-ordering recipe's bound
- **AND** SHALL NOT be treated as recovered solely because scratch was absent

#### Scenario: next identical fault uses the same recipe

- **WHEN** a later issue hits the same post-PR missing-implementation-role ordering
- **THEN** recovery SHALL use the same diagnostic-scoped bind-or-reproduce recipe
- **AND** SHALL NOT require a new issue-specific mole or an FRG-only recoverer

#### Scenario: recovery does not weaken binding or invent a subject

- **WHEN** recovery runs the bind-or-reproduce recipe
- **AND** trusted-surface is still `blocked` or the PR head is unobservable
- **THEN** recovery SHALL fail closed with the typed blocker
- **AND** SHALL NOT mark the consumer stage complete
- **AND** SHALL NOT write a fabricated `evidence_subject`

#### Scenario: disabled-gate not-applicable is not recovered

- **WHEN** recovery runs the bind-or-reproduce recipe
- **AND** the helper reports `ok: true` with action `not-applicable` because `test_gate.enabled` is false and no SHA-matched passed Tester record exists
- **THEN** recovery SHALL NOT clear `pipeline:blocked`
- **AND** SHALL NOT report the blocker recovered
- **AND** SHALL leave the blocker in place for the consumer observer to evaluate exact product-path proof

#### Scenario: recovery bind uses the blocked run's persisted engine identity

- **WHEN** recovery binds a subject-less Tester record from a blocked run directory
- **AND** that run's `run.json.engine` records identity A
- **AND** the currently installed engine is identity B
- **THEN** `evidence_subject.engine_fingerprint` SHALL derive from A
- **AND** SHALL NOT derive from B

#### Scenario: recovery fail-closes when blocked-run engine identity is absent

- **WHEN** recovery runs the bind-or-reproduce recipe
- **AND** the blocked run directory has no well-formed `run.json.engine`
- **THEN** recovery SHALL fail closed
- **AND** SHALL NOT clear `pipeline:blocked`
- **AND** SHALL NOT rewrite Tester evidence with the currently installed engine identity
