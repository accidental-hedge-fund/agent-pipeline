# human-intervention-taxonomy Specification

## Purpose
TBD - created by archiving change human-intervention-taxonomy. Update Purpose after archive.

## Requirements

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

### Requirement: HumanInterventionKind SHALL be a derived reporting projection, not an authority classifier

The engine SHALL treat `HumanInterventionKind` as a pure reporting/metrics projection derived
from the canonical stage-diagnostic reason vocabulary and closed site context. Adding or using a
`HumanInterventionKind` value SHALL NOT by itself authorize a human hold, a `needs-human`
transition, or suppression of engine-owned recovery. In particular, `review-non-convergence`
MAY remain a reporting dimension for factory-debt metrics but MUST NOT act as the authority
classifier: unresolved review non-convergence SHALL continue to project to engine-owned
`review-findings` recovery unless a separate current `human-decision-required` diagnostic with
authority evidence is present.

#### Scenario: review-non-convergence reports without granting authority

- **WHEN** review routing records non-convergence for metrics using kind `review-non-convergence`
- **THEN** that kind alone SHALL NOT create a human hold or `needs-human` authority transition
- **AND** recovery classification SHALL follow the canonical `review-findings` (or other
  engine-owned) diagnostic projection

#### Scenario: Projection covers known intervention kinds

- **WHEN** each production intervention emission is inspected
- **THEN** its `kind` SHALL be derived from the canonical reason / blocker projection mapping
- **AND** unrecognized kinds SHALL continue to aggregate as `unknown` for consumers
)

### Requirement: Pre-merge base-branch merge conflict is not human authority by default

A first clean auto-rebase conflict during pre-merge recovery SHALL NOT authorize a
human hold, `needs-human` authority transition, or suppression of engine-owned
conflict resolution solely because a reporting kind exists. The reporting kind
`merge-conflict-or-branch-drift` (and any projection of a pre-merge true
CONFLICTING/DIRTY recovery) SHALL remain a metrics / reporting dimension only unless
a separate current human-authority diagnostic is present. Engine-owned recovery
(bounded resolve → push → re-enter pre-merge) remains mandatory until resolution
budget exhaustion maps to a product / engine-owned failure, not a “manual rebase
needed” human class.

#### Scenario: First-conflict recovery does not grant human authority via taxonomy

- **WHEN** pre-merge detects CONFLICTING or DIRTY mergeability and clean auto-rebase
  hits conflicts
- **THEN** classification MAY still record a reporting projection related to
  merge-conflict-or-branch-drift for metrics if needed
- **AND** that projection alone SHALL NOT create a human hold or authorize skipping
  engine-owned conflict resolution
- **AND** recovery SHALL proceed under engine-owned pre-merge conflict law until
  budget exhaustion or success

#### Scenario: Budget-exhausted product failure is not manual-rebase human class

- **WHEN** pre-merge conflict resolution budget is exhausted with residual conflicts
- **THEN** any human-intervention reporting kind SHALL NOT re-label the terminal as
  operator “manual rebase needed” authority solely for that exhaust
- **AND** the terminal SHALL remain a product / engine-owned failure with conflict
  evidence as specified by pre-merge-conflict-detection
