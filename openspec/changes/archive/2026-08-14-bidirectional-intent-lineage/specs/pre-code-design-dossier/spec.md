## ADDED Requirements

### Requirement: Approved objective manifest entries SHALL project into the intent-lineage graph

When an approved dossier produces a compact objective manifest of stable `objective_id` values and content hashes, the engine SHALL project each accepted entry into the intent-lineage graph as an `objective` node (or equivalent documented node type) addressable by that identity. Downstream verification mapping for those objectives SHALL be expressible as lineage edges. This projection SHALL NOT introduce a second planning state machine or a parallel objective-manifest file format.

#### Scenario: approved objective becomes a lineage node

- **WHEN** a dossier is approved with objective id `obj-login-retry` and content hash `H1`
- **THEN** lineage projection SHALL upsert an objective node whose identity material includes `obj-login-retry` and `H1`

#### Scenario: content change yields new revision not silent overwrite without supersession

- **WHEN** the same objective id is re-approved with a different content hash `H2`
- **THEN** lineage SHALL record a new revision and supersession or stale relationship relative to `H1`
- **AND** SHALL NOT leave only an untraceable overwrite with no revision history

#### Scenario: no second planning state machine

- **WHEN** objective entries are projected into lineage
- **THEN** the pipeline SHALL continue to derive the compact objective manifest from the approved dossier per existing rules
- **AND** SHALL NOT add stage labels solely to host a second planning artifact family
