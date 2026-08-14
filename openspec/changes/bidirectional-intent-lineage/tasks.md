## 1. Schema and pure graph core

- [x] 1.1 Define TypeScript types and `schema_version: 1` validators for lineage nodes, edges, link states, provenance, and closed enums under `core/scripts/` (lineage module).
- [x] 1.2 Implement pure graph integrity checks (endpoint existence, enum validity, domain-scoped ids, no fabricated SHA/run placeholders).
- [x] 1.3 Implement component/capability identity helpers (domain-scoped keys, ownership metadata attach, collision rules).
- [x] 1.4 Unit tests: identity stability, supersession, integrity failures, cross-domain non-collision, privacy redaction hooks on free-text fields.

## 2. Store layout

- [x] 2.1 Define host-local store path under `.agent-pipeline/lineage/` (nodes/edges or equivalent) with append/upsert semantics and optional index.
- [x] 2.2 Implement retention window filtering for default export; document config key.
- [x] 2.3 Unit tests with injected fs: write/read, retention exclusion, non-fatal partial reads.

## 3. Artifact ingest projectors

- [x] 3.1 Projector: approved dossier objectives (`objective_id` + content hash) → `objective` nodes; supersession on hash change.
- [x] 3.2 Projector: runs, commits/PRs (trailers), verification refs → nodes/edges with observed vs inferred authority.
- [x] 3.3 Projector: production outcomes + attribution → `production_outcome` nodes/edges preserving many-to-many and dispute.
- [x] 3.4 Projector: consequential decisions (`answered`/`deferred`/`open`) and policy/override lifecycle events as invalidation inputs.
- [x] 3.5 Projector: issue/OpenSpec requirement path+hash when available.
- [x] 3.6 Unit tests: no invented ids, trailer observed joins, heuristic inferred, empty outcome store non-fatal, objective resume stability.

## 4. Impact analysis

- [x] 4.1 Pure forward impact walk with closed `drift_reason_code` set and JSON report shape.
- [x] 4.2 Pure backward proposal emitter (`lineage_update_proposal`, non-applied by default).
- [x] 4.3 Apply path: require human or repository-workflow approval; refuse unauthorized mutation; record decision provenance on success.
- [x] 4.4 Optional completeness gate (default off): fail safely on missing required observed edges when armed.
- [x] 4.5 Unit tests: forward stale objectives, backward non-applied proposal, unauthorized apply refused, armed gate fail-closed, default-off autonomy.

## 5. Evidence export and CLI

- [x] 5.1 Evidence-bundle / summary lineage section (counts, objective ids, impact/proposal refs, drift codes, empty/skip reason).
- [x] 5.2 CLI surfaces for export, impact, and propose (JSON + human-readable summary); no hosted UI.
- [x] 5.3 Unit tests for export shapes and summary rendering with fixtures.

## 6. End-to-end fixture and composition

- [x] 6.1 Build offline fixture: intent → requirement → #575-style objective → run/commit → verification → #576-style outcome.
- [x] 6.2 Assert forward impact after upstream requirement revision and backward proposal from reversion outcome.
- [x] 6.3 Assert composition: same objective_id / outcome_id / evidence_subject dimensions as source stores (no parallel incompatible ids).

## 7. Docs, mirror, validation gate

- [x] 7.1 Document privacy, retention, redaction, repository boundaries, and cross-repo identity collision rules (design + operator-facing notes as needed).
- [x] 7.2 If `core/` changes: run `node scripts/build.mjs` and commit regenerated `plugin/`.
- [x] 7.3 Run `openspec validate bidirectional-intent-lineage` and `npm run ci` until green.
