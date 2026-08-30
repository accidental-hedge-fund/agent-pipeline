## RENAMED Requirements

- FROM: ### Requirement: Documentation SHALL list the full set of ignored artifact paths
- TO: ### Requirement: Durable documentation SHALL list the full set of ignored artifact paths

## MODIFIED Requirements

### Requirement: Durable documentation SHALL list the full set of ignored artifact paths

The README and/or linked durable operator documentation SHALL derive or validate
its local-only `.agent-pipeline/` inventory from `ARTIFACT_CONTRACT`. Wherever
either surface enumerates those paths, it SHALL enumerate every current contract
entry rather than cache a hand-maintained strict subset. The current twelve-entry
inventory is `.agent-pipeline/runs/`, `.agent-pipeline/roadmap/`,
`.agent-pipeline/history/`, `.agent-pipeline/evals/`,
`.agent-pipeline/control-attributions.jsonl`,
`.agent-pipeline/product-fault-reports.jsonl`, `.agent-pipeline/handoffs/`,
`.agent-pipeline/outcomes/`, `.agent-pipeline/lineage/`,
`.agent-pipeline/frg/`, `.agent-pipeline/harness-ownership/`, and
`.agent-pipeline/factory-release/`. Generated short host one-pagers MAY link to
that documentation; they SHALL NOT be required to duplicate the full
artifact-path inventory.

#### Scenario: Docs enumerate all three paths

- **WHEN** a reader consults the durable documentation for the engine's
  local-only artifact paths
- **THEN** the listed paths SHALL include `.agent-pipeline/runs/`,
  `.agent-pipeline/roadmap/`, `.agent-pipeline/history/`,
  `.agent-pipeline/evals/`, `.agent-pipeline/control-attributions.jsonl`,
  `.agent-pipeline/product-fault-reports.jsonl`, `.agent-pipeline/handoffs/`,
  `.agent-pipeline/outcomes/`, `.agent-pipeline/lineage/`,
  `.agent-pipeline/frg/`, `.agent-pipeline/harness-ownership/`, and
  `.agent-pipeline/factory-release/`
- **AND** a drift guard SHALL compare the durable inventory with every current
  `ARTIFACT_CONTRACT` entry so a thirteenth entry cannot leave the docs stale

#### Scenario: Generated one-pager does not cache the inventory

- **WHEN** the artifact contract gains or removes an entry
- **THEN** generated short host one-pagers SHALL remain valid through their
  durable documentation pointer
- **AND** they SHALL NOT be required to carry a second path list that can drift
