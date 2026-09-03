## MODIFIED Requirements

### Requirement: A closed HumanInterventionKind enum defines every taxonomy member
The engine SHALL define a `HumanInterventionKind` string union in `core/scripts/intervention.ts` whose members are:

- `"ambiguous-issue"` — planning exits because the issue is underspecified
- `"product-judgment-required"` — a stage defers to a human for a product decision
- `"plan-review-feedback"` — a human edits or rejects the generated plan
- `"review-non-convergence"` — review ceiling reached; reporting dimension only
- `"test-build-failure"` — test/build gate fails and auto-fix is exhausted; reporting dimension only
- `"eval-shipcheck-failure"` — eval or ship-check gate fails; reporting dimension only
- `"merge-conflict-or-branch-drift"` — pre-merge detects a conflict or stale branch; reporting dimension only
- `"auth-tooling-preflight-failure"` — doctor preflight or auth check fails; reporting dimension only
- `"human-risk-override"` — operator supplies `--override` to accept a blocked finding
- `"reviewer-unavailable"` — same-harness fallback or reviewer cannot be reached; reporting dimension only
- `"unknown"` — catch-all for any intervention point not mapped to a known kind; reporting dimension only

The enum SHALL be the single source of truth. Adding a new intervention kind SHALL require only updating this enum and the call site mapping; no other file SHALL hard-code the set of valid kind strings. Members marked reporting dimension only SHALL NOT grant human ownership, `typed-input-wait`, or cancellation. Those faults SHALL remain RecoverySupervisor-owned Cooling or recovery unless the shared classifier emits a current typed request.

#### Scenario: every taxonomy member serializes to a stable string
- **WHEN** a `HumanInterventionKind` value is serialized to JSON
- **THEN** it SHALL appear as the exact string listed above (e.g. `"review-non-convergence"`)
- **AND** the string SHALL be identical across all events and records in the same run

#### Scenario: unknown kind is the escape hatch, not an error
- **WHEN** an intervention point cannot map to any known kind
- **THEN** the emitter SHALL use `"unknown"` rather than throwing or omitting the kind field
- **AND** the resulting event SHALL be valid and written to `events.jsonl`
- **AND** that kind SHALL NOT create human ownership

#### Scenario: new kind added without breaking existing consumers
- **WHEN** a new member is added to `HumanInterventionKind`
- **THEN** existing consumers that treat unrecognized kind strings as `"unknown"` for aggregation SHALL continue to function correctly
- **AND** `schema_version` SHALL NOT be incremented solely for the addition of a new kind member

#### Scenario: exhausted test-build-failure is not human ownership
- **WHEN** a test or build gate fails and auto-fix is exhausted
- **THEN** reporting MAY use kind `test-build-failure`
- **AND** RecoverySupervisor SHALL retain ownership as Cooling
- **AND** that kind alone SHALL NOT create `pipeline:needs-human` human authority
