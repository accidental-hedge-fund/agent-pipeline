# engine-scratch-recover Specification

## Purpose
Deterministically classify and recover engine-owned scratch porcelain so scratch-only dirt unlinks and clears without escalating to needs-human or train STOP, while product dirt stays fail-closed.

## Requirements

### Requirement: Engine-owned scratch-only porcelain SHALL recover without needs-human escalation

When worktree porcelain lists only paths in the engine-known non-product scratch set (including at least pipeline-owned `artifacts/challenge-response-*.json` dumps and existing pipeline-internal markers / planning scratch already treated as non-product), the pipeline SHALL treat that state as **engine scratch**, not product dirt and not a human-authority hold. The pipeline SHALL NOT set `pipeline:blocked` or transition to `pipeline:needs-human` solely for that scratch-only porcelain. Uncommitted product paths under `core/`, generated `plugin/`, dirty product `openspec/` content, recognized lockfiles handled by lockfile fold (not scratch), and other non-scratch paths SHALL still hard-block. The engine SHALL NOT waive the entire `artifacts/**` tree as scratch.

#### Scenario: Challenge-response-only porcelain does not needs-human

- **WHEN** porcelain lists only `?? artifacts/challenge-response-N.json` (or an equivalent engine-known scratch path already in the shared non-product set)
- **AND** no product path is uncommitted
- **THEN** the pipeline SHALL NOT set `pipeline:blocked` solely for that porcelain
- **AND** SHALL NOT transition the item to `pipeline:needs-human` solely for that porcelain

#### Scenario: Product dirt still hard-blocks

- **WHEN** porcelain includes an uncommitted path under `core/` or other product/non-scratch paths
- **THEN** the pipeline SHALL hard-block with product-path disclosure
- **AND** SHALL NOT treat co-present engine scratch as sufficient to pass cleanliness

#### Scenario: Broad artifacts tree is not waived

- **WHEN** porcelain includes an untracked path under `artifacts/` that is not an engine-known scratch pattern
- **THEN** the pipeline SHALL NOT classify that path as ignorable engine scratch solely because it lives under `artifacts/`

---

### Requirement: Scratch recovery SHALL unlink engine scratch before implementer repair

For the engine-scratch / workflow-engine recovery path, the autonomous recovery recipe set SHALL include a deterministic **unlink engine scratch** action that removes or restores only engine-known scratch paths and, when the active block was caused by scratch-only dirt, clears `pipeline:blocked`. That action SHALL be ordered **ahead of** any implementer `repair_pipeline_item` (or equivalent harness repair) for the same class. A successful scratch-only recovery SHALL resume normal advance without creating a human hold. The recipe SHALL NOT auto-commit scratch into the product tree and SHALL NOT invoke the implementer repair harness when unlink alone clears the block.

#### Scenario: Scratch-only recovery unlinks and does not repair

- **WHEN** a recoverable diagnostic projects to engine-scratch / workflow-engine with porcelain that is scratch-only under the engine-known set
- **THEN** the controller SHALL claim and execute the unlink-engine-scratch recipe before `repair_pipeline_item`
- **AND** after unlink, when no product dirt remains, it SHALL clear `pipeline:blocked` if present for that scratch cause
- **AND** it SHALL NOT invoke `repair_pipeline_item` for that attempt

#### Scenario: Recipe order places unlink ahead of implementer repair

- **WHEN** the permitted recipe sequence for the engine-scratch / workflow-engine path is inspected under test
- **THEN** unlink-engine-scratch SHALL appear before `repair_pipeline_item`
- **AND** a unit test SHALL fail if implementer repair is selected first for scratch-only evidence

#### Scenario: Mechanical scratch recover is not a human hold

- **WHEN** unlink-engine-scratch succeeds for scratch-only evidence
- **THEN** the controller SHALL NOT create a human hold or emit `human_intervention` solely for that recover
- **AND** the item SHALL re-enter normal whole-item execution when otherwise eligible
