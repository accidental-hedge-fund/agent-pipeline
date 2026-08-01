## ADDED Requirements

### Requirement: Review non-convergence SHALL remain engine-owned through recovery
Actionable unresolved review findings SHALL project to the canonical reason code
`review-findings`, durable class `review-findings`, and disposition `recover`. This applies to
eligible exact recurrence, non-demotable surface recurrence, and non-demotable repair-bound ceiling
exhaustion. The diagnostic SHALL carry the reviewed SHA plus each blocking finding's stable key,
payload fingerprint, severity, title, location, and recommendation so `repair_pipeline_item` can act
without reconstructing intent from labels or prose. No such review-policy outcome SHALL create a
human hold or emit `human_intervention` without a separate current human-decision diagnostic.

#### Scenario: Exact recurrence enters the recovery controller
- **WHEN** a trusted prior-run review and its production fix transitions prove every blocker remains after candidate movement
- **THEN** the stage SHALL emit canonical `review-findings` recovery evidence
- **AND** the controller SHALL attempt its configured recipes before typed exhaustion

#### Scenario: Review diagnostic is mechanically actionable
- **WHEN** `repair_pipeline_item` receives a review non-convergence diagnostic
- **THEN** the evidence SHALL identify the reviewed SHA and the key, fingerprint, severity, location, and remediation for every blocker

#### Scenario: Review policy does not grant human authority
- **WHEN** recurrence, surface recurrence, or a round ceiling remains blocking
- **THEN** the controller SHALL NOT create a human hold or human-intervention event solely from that policy result

### Requirement: Stage diagnostics SHALL include review-findings as a canonical reason
The closed `pipeline/stage-diagnostic@1` reason-code set SHALL include `review-findings`, and its
exhaustive projection SHALL map only to durable class `review-findings` with disposition `recover`.
Unknown reason codes SHALL remain protocol failures.

#### Scenario: Review diagnostic projects exactly
- **WHEN** a valid diagnostic carries reason code and blocker kind `review-findings`
- **THEN** projection SHALL return durable class `review-findings` and disposition `recover`

### Requirement: Review recovery SHALL perform substantive repair before redispatch
The default policy for durable class `review-findings` SHALL contain only
`repair_pipeline_item`, with bounded retry and repeated-evidence budgets. Stage-local auto-loop
SHALL not consume this block. A successful repair SHALL prove a new remote candidate before the
normal whole-item pipeline is redispatched.

#### Scenario: Label clearing is not review repair
- **WHEN** a review finding remains blocking at the same candidate
- **THEN** clearing `blocked` and redispatching without candidate movement SHALL NOT satisfy recovery
- **AND** the first durable recovery action SHALL be substantive repair
