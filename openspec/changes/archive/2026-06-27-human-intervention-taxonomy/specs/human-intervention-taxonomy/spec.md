## ADDED Requirements

### Requirement: A closed HumanInterventionKind enum defines every taxonomy member
The engine SHALL define a `HumanInterventionKind` string union in `core/scripts/intervention.ts` whose members are:

- `"ambiguous-issue"` — planning exits because the issue is underspecified
- `"product-judgment-required"` — a stage defers to a human for a product decision
- `"plan-review-feedback"` — a human edits or rejects the generated plan
- `"review-non-convergence"` — review ceiling reached; `needs-human` transition
- `"test-build-failure"` — test/build gate fails and auto-fix is exhausted
- `"eval-shipcheck-failure"` — eval or ship-check gate fails
- `"merge-conflict-or-branch-drift"` — pre-merge detects a conflict or stale branch
- `"auth-tooling-preflight-failure"` — doctor preflight or auth check fails
- `"human-risk-override"` — operator supplies `--override` to accept a blocked finding
- `"reviewer-unavailable"` — same-harness fallback or reviewer cannot be reached
- `"unknown"` — catch-all for any intervention point not mapped to a known kind

The enum SHALL be the single source of truth. Adding a new intervention kind SHALL require only updating this enum and the call site mapping; no other file SHALL hard-code the set of valid kind strings.

#### Scenario: every taxonomy member serializes to a stable string
- **WHEN** a `HumanInterventionKind` value is serialized to JSON
- **THEN** it SHALL appear as the exact string listed above (e.g. `"review-non-convergence"`)
- **AND** the string SHALL be identical across all events and records in the same run

#### Scenario: unknown kind is the escape hatch, not an error
- **WHEN** an intervention point cannot map to any known kind
- **THEN** the emitter SHALL use `"unknown"` rather than throwing or omitting the kind field
- **AND** the resulting event SHALL be valid and written to `events.jsonl`

#### Scenario: new kind added without breaking existing consumers
- **WHEN** a new member is added to `HumanInterventionKind`
- **THEN** existing consumers that treat unrecognized kind strings as `"unknown"` for aggregation SHALL continue to function correctly
- **AND** `schema_version` SHALL NOT be incremented solely for the addition of a new kind member

### Requirement: The taxonomy is documented with forward-compatibility guarantees
The `human-intervention-taxonomy` spec SHALL be the normative reference for the set of valid kind values. Consumers SHALL treat any kind string not listed in the current spec version as equivalent to `"unknown"` for aggregation purposes. The spec SHALL document that removing or renaming a kind member is a breaking change requiring a `schema_version` bump on the `human_intervention` event.

#### Scenario: consumer encounters an unrecognized kind string
- **WHEN** a consumer reads a `human_intervention` event whose `kind` value is not in its known set
- **THEN** it SHALL treat the event as `kind: "unknown"` for counting and filtering
- **AND** it SHALL preserve the original `kind` string in the raw event record

#### Scenario: removing a kind member requires a schema_version bump
- **WHEN** an existing kind member is removed from the enum
- **THEN** the `schema_version` on `human_intervention` events SHALL be incremented
- **AND** a migration note SHALL document the removed member
