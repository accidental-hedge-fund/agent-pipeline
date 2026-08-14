## Context

See proposal.md for motivation and acceptance criteria.

Today the factory has:

- Per-run evidence under `.agent-pipeline/runs/<run-id>/` and evidence-bundle / summary surfaces.
- #575 pre-code design dossier + objective manifest (`objective_id` + content hash) and attestation records.
- #576 production outcome store and `outcome-linkage` attribution with observed-vs-inferred authority.
- #692 versioned `evidence_subject` for readiness identity (candidate SHA, policy/engine/verifier fingerprints).
- Commit trailers (`Issue`, `Pipeline-Run`) and OpenSpec / issue / PR native artifacts.

Missing is a single versioned graph that types those artifacts as nodes, edges them with provenance and revision, and runs deterministic forward/backward impact without a second planning SM or a document editor.

**Constraints:** edit `core/` only (then regen `plugin/`); pure helpers + deps injection in unit tests; no live network in tests; host-local customer-hosted default; advance never merges; surgical product-fix discipline remains for ordinary findings—this capability is an evidence/store feature, not a new stage machine.

## Goals / Non-Goals

**Goals:**

- Versioned node/edge schema with stable IDs and explicit link-quality states.
- Component/capability identity as shared metadata for attestation, outcomes, and lineage.
- Projection (ingest) from existing authoritative sources—do not re-author content.
- Deterministic forward impact and backward proposals with fail-safe incomplete lineage.
- Human/repo workflow approval before mutating authoritative upstream artifacts.
- Export surfaces usable without a hosted UI; Warrant consumes, Pipeline produces.

**Non-Goals:**

- Collaborative docs, generic PM, universal ontology, hosted control plane.
- Causal inference or automatic product-intent rewrite.
- Replacing OpenSpec, GitHub, run store, outcome store, or evidence_subject.
- Second planning state machine or a parallel objective-manifest format (reuse #575 IDs via the graph).
- Merge/auto-merge or new mandatory pipeline stages solely for lineage.

## Decisions

### D1 — Evidence graph as side store, projection-first

**Decision:** Persist lineage under a host-local durable graph store (e.g. `.agent-pipeline/lineage/`) as versioned node and edge records (plus optional index files). Populate primarily by **projecting** identities from authoritative sources (issue/spec refs, OpenSpec paths/revisions, dossier objective ids, run_ids, SHAs, PRs, verification refs, outcome_ids, decision records, policy/override event ids). Do not require rewriting `summary.json` or outcome files when later edges arrive.

**Rationale:** Late outcomes and multi-run decomposition match the #576 side-store pattern; keeps run immutability; allows cross-run edges.

**Alternatives:** Embed only inside each run directory — rejected (cross-run/cross-release decomposition). Single global hosted graph — rejected for v1 (customer-hosted offline).

### D2 — Closed node and edge type enums with open metadata

**Decision:** `schema_version: 1` uses closed enums for:

| Node type (minimum) | Role |
| --- | --- |
| `intent_outcome` | User/business outcome statement (issue- or product-level) |
| `requirement` | Repo-native requirement / OpenSpec requirement / issue acceptance criterion |
| `dossier_contract` / `objective` | #575 behavioral contract and objective_id projection |
| `decision` | Consequential `answered` / `deferred` / `open` decision evidence |
| `run` | Pipeline run |
| `commit` / `pr` | Git commit or pull request |
| `verification` | Test/eval/shipcheck evidence ref |
| `production_outcome` | #576 outcome record projection |
| `component` / `capability` | Boundary identity (see D3) |
| `policy_event` / `override_event` | #693/#695 lifecycle events that participate in invalidation |

Edge types (minimum): `implements`, `derived_from`, `verifies`, `delivered_by`, `outcome_of`, `decomposes_to`, `supersedes`, `invalidates`, `disputes`, `owned_by`, `maps_evidence`, `affected_by_policy`.

Each edge carries: `source_id`, `target_id`, `relationship`, `provenance` (producer, method, authority), `revision`, optional `evidence_subject` ref or embedded #692 dimensions for verification/readiness-mapped edges, and link state (`active` | `stale` | `disputed` | `missing` | `unknown` | `superseded`).

**Rationale:** Closed types keep impact algorithms deterministic; open redacted notes allow human context without free-form ontology explosion.

### D3 — Component/capability identity is first-class and shared

**Decision:** Define stable `component_id` / `capability_id` keys (repo-scoped path prefixes and/or logical module keys) with optional ownership metadata used by #575 attestation routing and #576 component attribution. Identity collision across repositories is prevented by requiring a `domain` (or repository identity) prefix in the global id form: `{domain}::{component_id}`.

**Rationale:** Issue requires shared boundary definitions; domain-prefixing matches multi-repo lock key lessons (#634).

**Alternatives:** Free-text labels only — rejected (unstable). CODEOWNERS-only — useful input, not sole schema.

### D4 — Objective manifest reuses the graph (no second planning artifact)

**Decision:** Approved #575 objective entries (`objective_id` + content hash) **are** lineage nodes (type `objective` / `dossier_contract`). Verification and shipcheck evidence attach via `verifies` / `maps_evidence` edges. Do not invent a second compact-manifest file format or planning SM.

**Rationale:** Human comment + #575 living requirement; issue non-goal against new planning machinery.

### D5 — Forward impact is pure graph walk + reason codes

**Decision:** Given a revised node (new revision id/hash), a pure function walks directed downstream edges and emits an impact report:

- affected node ids and types
- edge path(s)
- stable `drift_reason_code` values (e.g. `upstream_requirement_revised`, `objective_content_hash_changed`, `component_ownership_changed`, `policy_event_invalidated`, `verification_subject_mismatch`)
- completeness diagnostics for missing edges

No LLM required for the report itself.

**Rationale:** Acceptance criteria demand deterministic forward pass; matches engine preference for deterministic recipes over LLM-first recovery.

### D6 — Backward proposals are non-authoritative until approved

**Decision:** Backward pass emits `lineage_update_proposal` records (reviewable JSON) that cite downstream evidence and proposed upstream node edits. Writers that mutate OpenSpec/requirements/dossier sources **MUST** require explicit human or repository-owned workflow approval recorded as a decision/attestation edge. Agents MAY draft proposals only; silent apply is forbidden and unit-tested.

**Rationale:** Issue forbids silent upstream mutation and product-authority grant.

### D7 — Incomplete and disputed links fail safely

**Decision:** Missing/ambiguous/disputed many-to-many links stay on the graph with explicit states and diagnostics. Optional config `lineage.completeness_gate` (disabled by default) may fail readiness composition or a CLI gate when required edge classes are missing for triggered work—never invent links to pass.

**Rationale:** Mirrors #575/#576 fail-safe patterns; default-off preserves autonomy for unconfigured repos.

### D8 — Privacy, retention, repository boundaries

**Decision:**

- Default store host-local under `.agent-pipeline/lineage/`.
- Free-text fields: injection denylist + secret redaction; no raw prompts, model dumps, or source trees.
- Retention: configurable window; expired nodes/edges excluded from default export (operator delete is explicit).
- Cross-repo edges require both domain identities; node ids include domain to prevent collision.
- Fleet export of lineage is out of v1 unless later mapped through fleet-data-governance; Warrant reads local/export JSON.

**Rationale:** Align with production-outcome and fleet governance without requiring fleet for dogfood.

### D9 — CLI and evidence export surfaces

**Decision:**

- CLI (names illustrative): `pipeline lineage export|impact|propose` with JSON default and optional human summary.
- Evidence bundle / summary gains a `lineage` section for the current run: node/edge counts, key objective edges, impact/proposal refs if computed, drift reason codes.
- No hosted UI in-repo.

**Rationale:** Acceptance criteria require export without UI; evidence-bundle is the existing operator surface.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Parallel identity stores vs #575/#576 | Projection only; same objective_id / outcome_id / evidence_subject dimensions; tests for dual-write consistency |
| Over-eager completeness gate blocks autonomy | Default gate off; document opt-in; inert when unconfigured |
| Heuristic edges look like facts | `authority: observed \| inferred`; impact reports label inferred paths |
| Graph growth | Retention window; compact indexes; projection of ids not full source blobs |
| Cross-repo false joins | Domain-prefixed ids; refuse undomained global ids |
| Scope creep into PM/docs product | Spec non-goals; ingest projections only; no editor |

## Migration Plan

1. Land schema validators + pure graph integrity tests (no runtime behavior change).
2. Land store + projectors for dossier objectives, runs/commits, verification, outcomes.
3. Land forward impact + backward proposal engines + unauthorized-mutation tests.
4. Wire evidence-bundle export + CLI; E2E fixture chain.
5. Optional completeness gate config (default off).
6. Dogfood on agent-pipeline after #575/#576 data present; rollback = ignore lineage dir / disable CLI (older engines treat unknown `.agent-pipeline/` files as non-fatal).

## Open Questions

- Exact CLI subcommand names and whether export is nested under `pipeline evidence` vs `pipeline lineage` — resolve at implement time without schema change if both remain pure readers.
- Whether `dossier_contract` and `objective` are one node type with a kind field or two enums — default in specs: single `objective` node type carrying contract hash + objective_id; revisable without proposal rewrite if tests stay green.
- Retention config key name (share generic evidence retention if one exists at implement time).
