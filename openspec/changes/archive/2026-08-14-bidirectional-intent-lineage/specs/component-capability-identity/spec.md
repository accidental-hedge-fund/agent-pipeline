## Purpose

Defines first-class component and capability identity and ownership metadata so lineage, pre-code attestation routing, and production outcome analysis share the same boundary definitions across repositories.

## ADDED Requirements

### Requirement: Component and capability identifiers SHALL be stable, domain-scoped, and first-class

The engine SHALL define `component_id` and `capability_id` as stable string keys. Each identifier used in lineage or shared attestation/outcome surfaces SHALL be scoped by repository `domain` (or equivalent repository identity) so the same path or module name in two domains cannot collide. Identifiers MAY derive from repository path prefixes, logical module keys, or documented ownership maps, but once assigned for a revision they SHALL remain stable for unchanged boundaries.

#### Scenario: domain-scoped component id is required for cross-repo use

- **WHEN** a component identity is emitted for cross-repository lineage
- **THEN** the identity SHALL include domain scope
- **AND** two domains with path `core/scripts` SHALL NOT share one unqualified global id

#### Scenario: unchanged boundary keeps stable id

- **WHEN** a component boundary definition is re-read without path or key change
- **THEN** the resolved `component_id` SHALL match the prior resolution

#### Scenario: empty component id is invalid for ownership edges

- **WHEN** an `owned_by` edge is validated with an empty `component_id`
- **THEN** validation SHALL fail

---

### Requirement: Ownership metadata SHALL be attachable without becoming merge or product authority

Component and capability records MAY carry ownership metadata (for example team key, CODEOWNERS path, or attestation route label) used for routing and impact analysis. Ownership metadata SHALL NOT by itself authorize merge, release, or silent mutation of upstream requirements.

#### Scenario: ownership metadata is queryable for impact

- **WHEN** a requirement node is linked to a component via `owned_by` or equivalent
- **THEN** forward impact reports MAY list the component ownership metadata for the affected set

#### Scenario: ownership is not merge authority

- **WHEN** a component has ownership metadata present
- **THEN** the engine SHALL NOT treat that metadata as operator merge authorization
- **AND** SHALL NOT auto-merge on ownership presence

---

### Requirement: Shared boundary definitions SHALL be reusable by attestation and outcome surfaces

Lineage component/capability identities SHALL be the same identity vocabulary consumable by pre-code attestation component routing (#575) and production outcome component attribution (#576). Producers SHALL NOT invent a parallel incompatible component key scheme for lineage alone when a repository already defines keys for those surfaces.

#### Scenario: attestation and lineage share component key

- **WHEN** attestation records an affected component key `core/scripts` under domain D
- **AND** lineage records an `owned_by` edge for the same work
- **THEN** both SHALL use the same domain-scoped component identity form
- **AND** consumers SHALL be able to join without a translation table invented per surface

#### Scenario: outcome component attribution joins lineage

- **WHEN** a production outcome attribution includes `target_type: "component"` with a component key
- **THEN** lineage projection SHALL reuse that key under the outcome's domain
- **AND** SHALL NOT mint a different synonym key for the same path without an explicit supersession record
