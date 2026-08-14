# Intent lineage graph (#599)

Repo-native, versioned evidence graph connecting intent → requirements →
objectives/contracts → runs → commits/PRs → verification → production outcomes.

## Store

- Path: `.agent-pipeline/lineage/` (host-local; see `LINEAGE_ARTIFACT` in `artifact-ignore.ts`)
- Layout: `nodes/<id>.json`, `edges/<id>.json`, optional `index.jsonl`
- Config keys:
  - `lineage.retention_days` (default **365**) — expired records excluded from default export
  - `lineage.completeness_gate` (default **off**) — when armed, fail closed on missing required observed edges

## Privacy and boundaries

- Free-text fields pass secret redaction + injection denylist; no raw prompts, secrets, or source dumps.
- Node ids are **domain-scoped** (`{domain}::{type}:{local}`) so issue `42` or path `core/scripts` in two repos cannot collide.
- Cross-repo edges require both domain identities.
- Default store is customer-hosted / host-local; no hosted UI required.

## CLI

```
pipeline lineage export  [--json] [--run-id <id>] [--retention-days <n>]
pipeline lineage impact  [--json] --node-id <id>
pipeline lineage propose [--json] [--evidence-node-id <id>]
pipeline lineage ingest  [--fixture <path>] [--dry-run] [--json]
```

Backward proposals never silently edit authoritative upstream artifacts.
Apply requires verified human or repository-workflow approval via an injected
`ApprovalVerifier` (`applyLineageProposal`); caller-asserted actor ids alone fail closed.

## Composition

- #575 objectives: same `objective_id` + content hash
- #576 outcomes: same `outcome_id` + attribution authority
- #692 `evidence_subject` dimensions on `verifies` / `maps_evidence` edges
