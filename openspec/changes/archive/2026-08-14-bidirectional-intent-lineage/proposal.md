## Why

Agent Pipeline already keeps strong per-run evidence, #575 behavioral contracts/objective manifests, and #576 production/rework outcome records. Those surfaces still do not share one versioned, typed lineage model, so the factory cannot answer which code and outcomes implement a changed requirement, which downstream artifacts go stale when intent changes, or which upstream assumptions should be revisited after implementation or production evidence—especially when one intent decomposes across issues, runs, repositories, or releases.

## What Changes

- Introduce a **repo-native, versioned intent-lineage evidence graph** with stable typed node identities, directed typed edges, provenance, revision, supersession, invalidation, disputed/missing/unknown link states, and first-class component/capability identity.
- Cover the chain **user/business outcome → requirement/spec → dossier contract/objective → run → commit/PR → test/eval/verification → production/rework outcome**, including consequential `answered` / `deferred` / `open` decisions as typed evidence (not hidden model reasoning).
- **Compose** with existing stores rather than replace them: #575 dossier/objective identities, #576 outcome records and attribution, #692 `evidence_subject` / candidate-policy-verifier identity on mapped evidence edges, and #693/#695 override and policy lifecycle events as invalidation/impact inputs.
- **Reuse this graph for the compact run objective manifest** already required by #575—stable objective IDs and content hashes map to verification and shipcheck evidence—without a second planning state machine or a parallel planning artifact family.
- Emit **deterministic forward change-impact reports** when upstream intent, requirements, architecture, contracts, component ownership, policy, or overrides revise.
- Emit **deterministic backward update proposals** when implementation, verification, incidents, rework, or outcomes reveal a stale or incomplete upstream assumption; proposals are reviewable and never silently edit authoritative upstream artifacts.
- Expose lineage and drift reason codes via **evidence exports and human-readable summaries** (CLI/JSON); Project Warrant may query/visualize; Agent Pipeline remains the authoritative producer.
- Document **privacy, retention, redaction, repository boundaries, and cross-repository identity collision** rules consistent with host-local evidence stores and fleet governance principles.

**Not in scope:** collaborative document editor / knowledge-base product; replacing GitHub, OpenSpec, issues, git, or repo-native specs; automatic rewriting of product intent from implementation; causal attribution from graph proximity; universal ontology or hosted control plane; generic project management expansion; auto-merge or new pipeline stages solely for lineage.

## Acceptance Criteria

- [ ] A versioned schema (`schema_version` integer, starting at `1`) defines artifact/node types, relationship/edge types, stable identifiers, component/capability identity, provenance, revision, supersession, and invalidation semantics.
- [ ] The schema covers at least: requirements/specs, dossier behavioral contracts/objectives, pipeline runs, commits/PRs, verification evidence, production/rework outcomes, consequential decisions (`answered`/`deferred`/`open`), and policy/override lifecycle events as invalidation-relevant nodes or edges.
- [ ] Linkage composes with #575 contract/objective and attestation evidence and #576 outcome records without a parallel incompatible identity store for those artifacts.
- [ ] Mapped evidence edges can carry or reference #692-style candidate / policy / verifier identity material (`evidence_subject` dimensions) so readiness and lineage share the same identity surface.
- [ ] One intent can decompose across multiple contracts, issues, runs, repositories, or releases; multiple outcomes can attach without collapsing attribution into a single score.
- [ ] A deterministic forward pass, given an upstream revision, reports which downstream contracts, plans, tests, code, or delivered changes may be stale, with stable drift reason codes.
- [ ] A deterministic backward pass produces reviewable proposals to update upstream requirements, specs, blueprints, contracts, or controls from implementation and outcome evidence.
- [ ] Backward propagation never silently mutates authoritative upstream requirements or grants an agent product/release authority; mutation requires explicit human or repository-owned workflow approval.
- [ ] Missing, ambiguous, disputed, stale, and many-to-many relationships remain visible; when a configured lineage-completeness gate is armed, incomplete lineage fails safely rather than inventing links.
- [ ] At least one end-to-end fixture demonstrates intent → repo-native requirement → #575-style contract/objective → run/commit → verification → #576-style outcome, then both a forward impact pass and a backward proposal.
- [ ] Evidence exports and human-readable summaries expose relevant lineage edges and drift reason codes without a hosted UI.
- [ ] Privacy, retention, redaction, repository boundaries, and cross-repo identity collision rules are documented in design + specs and enforced by schema/store rules (no secrets/prompts/source dumps; default host-local store).
- [ ] Injected-deps unit tests cover identity stability, revision/supersession, graph integrity, cross-run and cross-repo decomposition, forward impact, backward proposals, ambiguous attribution, missing links, and unauthorized upstream mutation resistance.
- [ ] Specs validate (`openspec validate bidirectional-intent-lineage`); implementation later keeps `npm run ci` green and regenerates `plugin/` only when `core/` changes.

## Capabilities

### New Capabilities

- `intent-lineage-graph`: Versioned evidence-graph schema (nodes, edges, stable IDs, provenance, revision, supersession, invalidation, link quality states, store layout, privacy/retention/cross-repo identity rules).
- `component-capability-identity`: First-class component and capability boundary identifiers and ownership metadata shared by lineage, #575 attestation routing, and #576 outcome analysis.
- `lineage-artifact-ingest`: Deterministic projection of repo-native and pipeline artifacts into the graph (issues/specs, OpenSpec scenarios, dossier objectives, runs, commits/PRs, verification, outcomes, decisions, policy/override events) without inventing identities.
- `lineage-impact-analysis`: Deterministic forward change-impact reports and backward update proposals with explicit approval before authoritative upstream mutation; optional completeness gate.

### Modified Capabilities

- `pre-code-design-dossier`: Approved objective manifest entries project into lineage nodes/edges (stable `objective_id` + content hash); no second planning state machine.
- `outcome-linkage`: Production/rework outcomes project into lineage as nodes and typed edges while preserving observed-vs-inferred authority and many-to-many attribution.
- `evidence-bundle`: Finalized evidence and human-readable summaries expose lineage export slices and drift reason codes for the run.

## Impact

- **Specs:** new `intent-lineage-graph`, `component-capability-identity`, `lineage-artifact-ingest`, `lineage-impact-analysis`; additive deltas on `pre-code-design-dossier`, `outcome-linkage`, `evidence-bundle`.
- **Code (implementation phase only):** pure graph model + validators under `core/scripts/`; host-local store under `.agent-pipeline/lineage/` (or documented path); ingest projectors; impact/proposal engines; CLI surfaces (e.g. `pipeline lineage impact|propose|export`); tests; `plugin/` regen if `core/` changes.
- **Composition:** consumes #575 dossier/objective/attestation evidence, #576 outcome store + linkage, #692 `evidence_subject`, run store / trailers, OpenSpec paths; does not rewrite those schemas into a single blob store.
- **Operators / consumers:** CLI + evidence summary; Project Warrant may query the produced graph; Pipeline remains sole authoritative writer of lineage for pipeline-produced edges.
- **Does not:** auto-merge; invent causation; silently edit OpenSpec/requirements; expand into generic PM; require a hosted UI.
