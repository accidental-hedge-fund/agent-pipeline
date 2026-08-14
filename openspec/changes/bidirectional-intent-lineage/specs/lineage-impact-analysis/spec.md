## Purpose

Defines deterministic forward change-impact reporting and backward update proposals on the intent-lineage graph, including fail-safe incomplete-lineage behavior and mandatory approval before authoritative upstream mutation.

## ADDED Requirements

### Requirement: Forward impact analysis SHALL report stale downstream artifacts after an upstream revision

Given a revised upstream node (new revision and/or content hash), the engine SHALL compute a deterministic forward impact report by walking directed downstream relationships. The report SHALL include at least:

- the upstream node id, type, and prior vs new revision identity
- each affected downstream node id and type (contracts/objectives, plans or requirement children, verification, commits/PRs, runs, production outcomes when linked)
- path or edge ids supporting the impact claim
- stable `drift_reason_code` values (closed set including at least `upstream_requirement_revised`, `objective_content_hash_changed`, `component_ownership_changed`, `policy_event_invalidated`, `verification_subject_mismatch`, `missing_downstream_link`)

The forward pass SHALL be pure with respect to the supplied graph snapshot (no network required).

#### Scenario: requirement revision marks downstream objectives stale

- **WHEN** a `requirement` node content hash changes and edges connect it to two `objective` nodes
- **THEN** the forward impact report SHALL list both objectives
- **AND** SHALL include drift reason code `upstream_requirement_revised` or `objective_content_hash_changed` as applicable

#### Scenario: component ownership change is reported

- **WHEN** a component ownership metadata revision changes for a component linked to active requirements
- **THEN** the forward impact report SHALL include affected requirement or objective nodes reachable via ownership edges
- **AND** SHALL include `component_ownership_changed`

#### Scenario: forward pass does not call a model

- **WHEN** impact is computed for a fixture graph
- **THEN** the computation SHALL complete from graph inputs alone
- **AND** SHALL NOT require an LLM harness invocation

---

### Requirement: Backward analysis SHALL emit reviewable update proposals without silently editing authority

Given downstream evidence (implementation, verification failure/success mismatch, production/rework outcomes, or disputed links), the engine SHALL be able to emit one or more `lineage_update_proposal` records that propose updates to upstream requirements, specs, blueprints, contracts, or controls. Each proposal SHALL include:

- proposal id
- target upstream node id(s)
- citing downstream evidence node/edge ids
- proposed change summary (bounded, redacted)
- authority status `proposal` (not applied)
- stable reason codes

The engine SHALL NOT apply those proposals to authoritative upstream artifacts as part of the default backward pass.

#### Scenario: outcome-driven proposal is non-applied

- **WHEN** a `production_outcome` of kind reversion links to a run that implemented objective O
- **THEN** backward analysis MAY emit a proposal targeting the requirement or objective upstream of O
- **AND** the authoritative requirement/objective content SHALL remain unchanged until approval

#### Scenario: proposal cites evidence

- **WHEN** a proposal is emitted
- **THEN** it SHALL reference at least one downstream evidence node or edge id
- **AND** SHALL set authority status indicating it is a proposal

---

### Requirement: Authoritative upstream mutation SHALL require explicit human or repository-owned workflow approval

Applying a lineage-driven change to an authoritative upstream artifact (OpenSpec requirement text, issue acceptance criteria treated as authority, approved dossier contract content, or repository-owned controls) SHALL require an explicit approval record from an authenticated human or a repository-owned workflow configured as the approval authority. Agents MAY draft proposals only. Unauthorized apply attempts SHALL fail closed, leave authority unchanged, and record a diagnostic or audit entry.

#### Scenario: agent apply without approval is refused

- **WHEN** an agent requests apply of a `lineage_update_proposal` without a recorded human or repository-workflow approval
- **THEN** the engine SHALL refuse the apply
- **AND** the upstream artifact SHALL remain unchanged
- **AND** a diagnostic such as `unauthorized_upstream_mutation` SHALL be recorded

#### Scenario: approved apply records decision provenance

- **WHEN** a valid approval is present and apply succeeds
- **THEN** the engine SHALL record a `decision` node or edge with status `answered` (or equivalent applied provenance)
- **AND** SHALL write a new upstream revision rather than silently rewriting history without supersession

#### Scenario: approval does not grant merge or release authority

- **WHEN** a proposal is approved for requirement text update
- **THEN** that approval SHALL NOT by itself authorize merge or production release
- **AND** existing merge authority boundaries SHALL remain unchanged

---

### Requirement: Incomplete lineage SHALL remain visible and fail safely when a completeness gate is armed

Missing, ambiguous, disputed, stale, and many-to-many relationships SHALL remain queryable in exports. When configuration enables a lineage completeness gate for a required edge class set, the engine SHALL fail safely (block the gated check) if required links are missing or only `inferred` when policy demands observed links. When the gate is disabled or omitted, incomplete lineage SHALL NOT invent links and SHALL NOT block autonomous runs solely for missing lineage.

#### Scenario: default-off gate does not block unconfigured repos

- **WHEN** lineage completeness configuration is omitted
- **THEN** ordinary advance paths SHALL NOT fail solely because lineage edges are incomplete
- **AND** exports MAY still list `missing` diagnostics

#### Scenario: armed gate fails on missing required edge

- **WHEN** completeness gate is enabled requiring observed `verifies` edges for each approved objective
- **AND** an objective has no observed verification edge
- **THEN** the gate SHALL fail safely
- **AND** SHALL name the objective id and reason code such as `missing_downstream_link`

#### Scenario: invented links to pass the gate are forbidden

- **WHEN** a required edge cannot be resolved from evidence
- **THEN** the engine SHALL NOT fabricate an observed edge to satisfy the gate

---

### Requirement: Impact and proposal outputs SHALL be exportable as JSON and human-readable summary text

Forward impact reports and backward proposals SHALL be serializable to JSON for evidence export and CLI consumption. A human-readable summary form SHALL list affected artifacts and drift reason codes without requiring a hosted UI.

#### Scenario: JSON impact export includes reason codes

- **WHEN** a forward impact report is exported as JSON
- **THEN** each affected item SHALL include at least one `drift_reason_code`
- **AND** the export SHALL be parseable without a UI

#### Scenario: human summary lists stale objectives

- **WHEN** a human-readable summary is rendered for an impact report that marks two objectives stale
- **THEN** the summary text SHALL name both objective ids (or their summaries)
- **AND** SHALL include the drift reason codes

---

### Requirement: End-to-end fixture SHALL demonstrate forward impact and backward proposal on one chain

The test suite SHALL include at least one offline fixture that projects intent → requirement → objective → run/commit → verification → production outcome, then runs forward impact after an upstream revision and backward proposal from a downstream outcome, asserting both outputs without live network.

#### Scenario: fixture chain supports both passes

- **WHEN** the end-to-end lineage fixture is loaded
- **AND** the requirement content hash is revised
- **THEN** forward impact SHALL report the downstream objective as affected
- **AND WHEN** a reversion outcome is attached to the run
- **THEN** backward analysis SHALL emit at least one non-applied proposal citing that outcome
