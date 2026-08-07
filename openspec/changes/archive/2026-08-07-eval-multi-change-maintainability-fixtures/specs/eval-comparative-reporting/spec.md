## ADDED Requirements

### Requirement: Multi-change reports SHALL present per-checkpoint and cumulative correctness with defect-state breakdowns

For multi-change experiments the comparative report SHALL present, per treatment and per checkpoint: strict pass rate (or equivalent), current-step defects, inherited defects, accumulated unresolved defects, and recovered defects, plus a lineage-level terminal all-green rate. Aggregates that compare treatments SHALL pair within the same multi-change fixture and checkpoint index so a later checkpoint is never compared against an earlier checkpoint of another treatment as if they were the same task.

#### Scenario: Checkpoint-aligned pairing

- **WHEN** treatments A and B both completed checkpoint C2 of fixture F
- **THEN** the report SHALL compute C2 deltas for F within checkpoint index C2
- **AND** SHALL NOT pair A's C2 against B's C1 as the same unit

#### Scenario: Defect-state fields are visible

- **WHEN** a multi-change summary is read
- **THEN** it SHALL expose current-step, inherited, accumulated, recovered, and terminal all-green dimensions per treatment

---

### Requirement: Multi-change reports SHALL include effort, growth, amplification, and structural telemetry as separate non-ground-truth dimensions

The multi-change report SHALL include per-change and cumulative time, tokens, cost (with unknown cost still reported as unknown coverage, never imputed zero), retries, human interventions, production and test code growth, change amplification and interface or touch-point churn, and deterministic structural telemetry. These dimensions SHALL remain separate from verifier-based correctness. The report SHALL NOT emit a single synthetic maintainability or slop score as ground truth.

#### Scenario: No collapsed maintainability score

- **WHEN** a multi-change comparative summary is produced
- **THEN** it SHALL NOT include a single field presented as overall maintainability or slop ground truth
- **AND** structural telemetry SHALL be listed separately from strict pass and defect states

#### Scenario: Cost unknown stays unknown

- **WHEN** a multi-change step lacks cost telemetry
- **THEN** cost aggregates SHALL exclude it and report coverage
- **AND** SHALL NOT treat missing cost as zero

---

### Requirement: Multi-change treatment comparison SHALL support bare-versus-pipeline baselines and optional variants

The report SHALL be able to name a baseline treatment (for example bare or just-solve) and compare Agent Pipeline and optional controlled variants against it on multi-change fixtures using the same pairing rules as other comparative reports. Optional variants include adversarial review, deterministic quality feedback, and #575 controls when present. Missing optional variants SHALL be reported as not-run rather than as zero-quality.

#### Scenario: Baseline is named for multi-change deltas

- **WHEN** a multi-change summary compares pipeline-current to bare
- **THEN** the summary SHALL name bare (or the configured baseline id) as the baseline treatment

#### Scenario: Absent optional variant is not zeroed

- **WHEN** a #575 or quality-feedback variant was not part of the experiment
- **THEN** the report SHALL NOT invent zeroed quality metrics for that variant as if it ran

---

### Requirement: Portability-probe checkpoints SHALL be reported with weaker-model metrics

When a multi-change fixture marks a portability-probe checkpoint with a weaker or cheaper model override, the report SHALL surface that checkpoint's correctness (including strict pass and defects), time, cost, and intervention under the weaker or cheaper model identity, distinct from the stronger model used on prior checkpoints in the same lineage.

#### Scenario: Weaker model metrics are labeled

- **WHEN** checkpoint N+1 runs under a weaker model after checkpoints 1..N under a stronger model
- **THEN** the report SHALL label N+1 results with the weaker model identity
- **AND** SHALL include correctness, time, cost, and intervention for that checkpoint
