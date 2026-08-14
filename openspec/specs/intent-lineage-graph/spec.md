# intent-lineage-graph Specification

## Purpose
Defines the versioned intent-lineage evidence graph: typed nodes and edges, stable identifiers, provenance, revision, supersession, invalidation, link-quality states, store layout, and privacy boundaries that connect intent through delivery and outcomes without replacing source systems.

## Requirements

### Requirement: Versioned lineage graph schema SHALL define nodes, edges, and stable identifiers

The engine SHALL define a durable intent-lineage graph with integer `schema_version` starting at `1`. Schema version `1` SHALL represent:

- **Nodes** with at least: `node_id` (stable string), `node_type`, `domain` (repository/domain identity), `revision` (monotonic or content-hash revision identity), `content_hash` (when content is projected), optional `component_id` / `capability_id`, optional bounded redacted `summary`, and `provenance` (producer id, observed_at).
- **Edges** with at least: `edge_id`, `source_id`, `target_id`, `relationship`, `provenance` (producer, method, authority `observed`|`inferred`), `revision`, optional mapped-identity block for verification/readiness edges, and `link_state`.

Readers SHALL ignore unknown fields under a supported `schema_version`. The graph SHALL NOT collapse multi-artifact attribution into a single score field.

#### Scenario: schema_version 1 node carries identity fields

- **WHEN** a producer emits a lineage node with `schema_version: 1`
- **THEN** the node SHALL include `node_id`, `node_type`, `domain`, `revision`, and `provenance`
- **AND** SHALL NOT require a single overall quality score field

#### Scenario: schema_version 1 edge carries relationship and endpoints

- **WHEN** a producer emits a lineage edge with `schema_version: 1`
- **THEN** the edge SHALL include `edge_id`, `source_id`, `target_id`, `relationship`, `provenance`, `revision`, and `link_state`

#### Scenario: unknown additive fields are ignored

- **WHEN** a record carries an unknown field under a supported `schema_version`
- **THEN** readers SHALL ignore the unknown field and continue

---

### Requirement: Node types SHALL cover the intent-to-outcome chain

Schema version `1` node types SHALL include at least:

- `intent_outcome`
- `requirement`
- `objective` (approved dossier behavioral contract / objective_id projection)
- `decision` (consequential answered/deferred/open decision evidence)
- `run`
- `commit`
- `pr`
- `verification`
- `production_outcome`
- `component`
- `capability`
- `policy_event`
- `override_event`

Producers SHALL NOT invent node types outside the closed set for v1 validation success.

#### Scenario: closed node type enum rejects unknown type

- **WHEN** a node is validated with `node_type: "wiki_page"`
- **THEN** schema validation SHALL fail
- **AND** the node SHALL NOT be written as authoritative

#### Scenario: objective node represents dossier contract identity

- **WHEN** an approved dossier objective is projected
- **THEN** a node of type `objective` SHALL carry the stable `objective_id` and content hash as identity material
- **AND** SHALL be addressable across resume without renumbering when content is unchanged

---

### Requirement: Edge relationship types SHALL support decomposition, implementation, verification, outcomes, supersession, and invalidation

Schema version `1` relationship values SHALL include at least:

- `implements`
- `derived_from`
- `verifies`
- `delivered_by`
- `outcome_of`
- `decomposes_to`
- `supersedes`
- `invalidates`
- `disputes`
- `owned_by`
- `maps_evidence`
- `affected_by_policy`

One source MAY connect to many targets and one target MAY connect to many sources (many-to-many). Supersession and invalidation SHALL be explicit edges or `link_state` transitions rather than silent deletion of prior history.

#### Scenario: one intent decomposes to multiple objectives and runs

- **WHEN** one `intent_outcome` maps to two `objective` nodes and two `run` nodes with evidence
- **THEN** the graph SHALL allow multiple `decomposes_to` / related edges without requiring a single child

#### Scenario: supersession retains prior revision

- **WHEN** requirement revision B supersedes revision A
- **THEN** an edge with relationship `supersedes` (or equivalent recorded supersession) SHALL link B to A
- **AND** node A SHALL remain readable with non-active or superseded state rather than being hard-deleted by default

#### Scenario: multiple outcomes attach without a collapsed score

- **WHEN** two `production_outcome` nodes attach to the same `run` or `commit`
- **THEN** both edges SHALL be representable
- **AND** validation SHALL NOT require a single numeric score combining them

---

### Requirement: Link state SHALL make missing, ambiguous, disputed, and stale relationships visible

Each edge SHALL carry `link_state` as exactly one of: `active`, `stale`, `disputed`, `missing`, `unknown`, `superseded`. Diagnostics MAY attach stable reason codes (e.g. `unresolved_target`, `authority_conflict`, `subject_mismatch`). Producers SHALL NOT invent endpoint identities solely to avoid `missing` or `unknown`.

#### Scenario: missing target is explicit

- **WHEN** an outcome signal has a PR id but no resolvable run node
- **THEN** the graph MAY record a partial edge or diagnostic with `link_state: "missing"` or `unknown`
- **AND** SHALL NOT fabricate a `run` node id that looks valid

#### Scenario: disputed dual attribution remains visible

- **WHEN** two inferred edges attribute the same outcome to different runs
- **THEN** both edges SHALL remain
- **AND** `link_state` SHALL be `disputed` (or each edge carries a dispute marker)
- **AND** consumers SHALL NOT silently keep only the last writer

#### Scenario: stale edge after upstream revision

- **WHEN** an upstream node's content hash changes and downstream edges still point at the prior revision
- **THEN** affected edges SHALL be markable `stale` with a stable drift reason code
- **AND** history of the prior active edge SHALL remain inspectable

---

### Requirement: Mapped verification and readiness edges SHALL bind shared evidence identity dimensions

When an edge of relationship `verifies` or `maps_evidence` binds an `objective` (or requirement) to verification or readiness evidence, the edge SHALL carry or reference the shared evidence identity surface used by `evidence_subject` (at least candidate identity, policy identity, and verifier identity dimensions when known). A run_id alone SHALL NOT be treated as complete mapped-evidence identity.

#### Scenario: verification edge includes subject dimensions when known

- **WHEN** verification evidence is linked to an objective for a candidate SHA under a known policy and verifier fingerprint
- **THEN** the edge or its identity block SHALL include those dimensions or an explicit null/unknown for each missing dimension
- **AND** SHALL NOT claim a complete match from `run_id` alone

#### Scenario: subject mismatch marks stale or disputed mapping

- **WHEN** stored mapped-evidence identity disagrees with the current evaluation pin on candidate SHA or policy hash
- **THEN** the edge SHALL NOT remain `active` without diagnostic
- **AND** SHALL be `stale` or carry a `subject_mismatch` reason code

---

### Requirement: Decision nodes SHALL record consequential answered, deferred, and open outcomes without hidden model reasoning

Nodes of type `decision` SHALL represent consequential workflow decisions with at least: stable decision id, status exactly one of `answered`, `deferred`, `open`, optional bounded redacted resolution text, and provenance of the deciding surface (human, repository workflow, or recorded gate). The graph SHALL NOT store raw chain-of-thought or full model transcripts as decision content.

#### Scenario: deferred decision is first-class

- **WHEN** a consequential design or product question is deferred
- **THEN** a `decision` node with status `deferred` SHALL be representable
- **AND** linked issues/objectives MAY reference it via typed edges

#### Scenario: model reasoning is not stored as authority

- **WHEN** a decision is recorded from a gate or human disposition
- **THEN** the node payload SHALL exclude raw model reasoning dumps
- **AND** SHALL include only redacted bounded resolution fields and provenance

---

### Requirement: Graph store SHALL be host-local by default with privacy, retention, and cross-repo identity rules

The default durable store location SHALL be host-local under the repository's `.agent-pipeline/lineage/` path (or a documented equivalent under `.agent-pipeline/`). Free-text fields SHALL pass injection denylist and secret redaction rules; producers SHALL NOT persist raw secrets, full source trees, or unredacted prompts. Retention SHALL be configurable; expired records SHALL be excluded from default exports. Cross-repository node identity SHALL include `domain` such that the same local path or issue number in two domains cannot collide as one `node_id`.

#### Scenario: default store is host-local

- **WHEN** lineage is persisted without fleet configuration
- **THEN** records SHALL be written under the host-local `.agent-pipeline/` lineage path for that repository workspace

#### Scenario: secrets are refused or redacted

- **WHEN** a projected summary would include an env secret or raw prompt body
- **THEN** the write path SHALL redact or refuse the field
- **AND** SHALL NOT store the secret material in the lineage record

#### Scenario: cross-domain issue numbers do not collide

- **WHEN** domain A and domain B both have issue `42`
- **THEN** their `requirement` or `intent_outcome` node ids SHALL differ by domain
- **AND** validation SHALL reject a global id that omits domain when cross-repo mode is used

#### Scenario: retention excludes expired records from default export

- **WHEN** a record is older than the configured retention window
- **THEN** default export consumers SHALL NOT include that record
- **AND** operator-scoped deletion remains available for customer-hosted cleanup

---

### Requirement: Graph integrity validation SHALL be pure and offline-testable

The engine SHALL provide pure (or deps-injected) validators that check referential integrity of edge endpoints within a fixture graph, closed enums, identity stability for unchanged content hashes, and rejection of invented placeholder SHAs or run ids. Unit tests SHALL exercise these rules without live network or real git.

#### Scenario: edge to unknown node fails integrity check

- **WHEN** an edge references a `target_id` absent from the graph fixture
- **THEN** integrity validation SHALL report a stable diagnostic
- **AND** SHALL NOT treat the graph as fully consistent

#### Scenario: unchanged content keeps stable node identity

- **WHEN** the same authoritative objective content is re-projected without content change
- **THEN** `node_id` and content hash identity material SHALL match the prior projection
