## MODIFIED Requirements

### Requirement: The Decisions artifact SHALL be versioned, embedded, and the sole source of the readable Decisions section

Pipeline SHALL embed a versioned Pipeline-owned Decisions artifact in the issue body. Each stable node SHALL record its question, recommendation, authority class, resolution, provenance reference, and input digests. Each newly written resolution SHALL also record rationale, alternatives, risk, and evidence. Those package fields SHALL NOT be part of the definition digest. Pipeline SHALL recompute those input digests from the live node definition fields (id, question, recommendation, class, and term_id) at parse, handoff materialize, and `--stage ready`. A stored digest that does not match the live fields SHALL fail closed. The canonical definition digest SHALL be bound on the grill-authority handoff declaration identity and `content_hashes`. `--stage ready` SHALL verify each pending or answered grill-authority record against that binding. It SHALL ignore superseded records. A pending or answered record whose digest does not match SHALL fail closed. Body-local `input_digests` and the Decisions fence checksum SHALL NOT be the authority binding for the applied node set. Pipeline SHALL render the readable `## Decisions` section from that same artifact. Divergence between the artifact and the rendered section SHALL fail validation at apply, handoff materialize, and `--stage ready`. The issue body SHALL remain the specification. Comments and handoffs MAY prove provenance. They SHALL NOT replace the body.

#### Scenario: Render matches artifact

- **WHEN** apply writes a body
- **THEN** the embedded artifact SHALL parse
- **AND** the `## Decisions` section SHALL equal the render of that artifact

#### Scenario: Divergent render fails ready

- **WHEN** the live body contains an artifact and a `## Decisions` section that do not match
- **THEN** `pipeline triage N --stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

#### Scenario: Comment is not the spec

- **WHEN** an issue comment states a decision that is absent from the body artifact
- **THEN** `--stage ready` SHALL NOT treat that comment as a settled node

#### Scenario: Duplicate or colliding fence fails validation

- **WHEN** the live body contains two `pipeline-decisions-v1` fences, or a digest that does not match the fence payload
- **THEN** apply, handoff materialize, and `--stage ready` SHALL fail closed
- **AND** labels and the body SHALL be unchanged on `--stage ready`

#### Scenario: Rewritten authority definition fails ready

- **WHEN** an applied body contains an unresolved operator-required node
- **AND** an editor changes that node's class or provenance, then recomputes the Decisions fence checksum and rendered section
- **THEN** `pipeline triage N --stage ready` SHALL exit 2
- **AND** labels SHALL be unchanged

#### Scenario: New resolution records the recommendation package

- **WHEN** grill or the shared classifier writes a new resolved or requested node
- **THEN** that node SHALL record recommendation, rationale, alternatives, risk, and evidence
- **AND** the definition digest SHALL still hash only id, question, recommendation, class, and term_id
