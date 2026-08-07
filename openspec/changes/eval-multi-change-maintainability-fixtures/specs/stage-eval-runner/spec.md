## ADDED Requirements

### Requirement: The runner SHALL execute multi-change fixtures as a checkpoint lineage with persistent repository state

When executing a multi-change fixture, the evaluation runner SHALL create one isolated worktree lineage per cell (fixture × treatment × replicate), check out the fixture `base_commit` once, and apply checkpoints in declaration order against that same worktree. After each checkpoint's treatment completes, the runner SHALL retain the resulting repository state for the next checkpoint. The runner SHALL NOT allocate a fresh base_commit worktree between checkpoints of the same multi-change cell.

#### Scenario: Second checkpoint sees first checkpoint's tree

- **WHEN** checkpoint C1's treatment modifies files in the cell worktree and C2 begins
- **THEN** C2's working tree SHALL include those modifications
- **AND** C2 SHALL NOT be reset to the original `base_commit` content

#### Scenario: Isolation from other cells is preserved

- **WHEN** two multi-change cells run for different treatments or replicates
- **THEN** each cell SHALL use its own worktree lineage
- **AND** neither cell SHALL read or write the other's worktree

---

### Requirement: Multi-change checkpoint execution SHALL use fresh model context and the declared evidence contract

For each checkpoint the runner SHALL invoke the treatment with a fresh model or session context. Between checkpoints the runner SHALL preserve repository state and only artifacts listed in the multi-change pipeline evidence contract for that treatment. The runner SHALL NOT pass prior checkpoint chat transcripts or held-out verifier definitions into the next treatment invocation.

#### Scenario: No chat carry-over

- **WHEN** C2 is invoked after C1 in the same multi-change cell
- **THEN** the treatment invocation for C2 SHALL not receive C1's conversation transcript as context

#### Scenario: Evidence contract is bounded

- **WHEN** the runner prepares C2 inputs
- **THEN** preserved non-repository inputs SHALL be limited to the declared evidence contract
- **AND** held-out verifiers SHALL be excluded from those inputs

---

### Requirement: Multi-change cells SHALL record a per-checkpoint evidence trail and continue after non-strict failures unless infra-class failures abort

For each checkpoint the runner SHALL record an evidence trail entry including at least: disclosed prompt identity or content hash, treatment id and configuration, model identity, repository revision or tree fingerprint after the step, verifier result summary references, and resource use (time, and tokens/cost when available). When a checkpoint fails strict pass for quality reasons, the runner SHALL continue to subsequent checkpoints in the same lineage so later recovery diagnostics remain available. Infrastructure, auth, or timeout result classes SHALL abort or mark the lineage according to existing cell result-class rules and SHALL NOT be counted as treatment quality outcomes.

#### Scenario: Evidence trail fields are present

- **WHEN** a multi-change checkpoint step completes
- **THEN** the cell record SHALL include prompt identity or hash, treatment id, model identity, post-step repository revision or fingerprint, verifier outcome references, and resource-use fields

#### Scenario: Quality non-strict does not drop later steps

- **WHEN** C1 fails strict pass due to verifier failure and no infra-class abort applies
- **THEN** the runner SHALL still execute C2 in the same lineage

#### Scenario: Infra abort stays out of quality

- **WHEN** a checkpoint ends in `infra_error`, `auth_error`, or `timeout`
- **THEN** that outcome SHALL use the existing non-quality result classification
- **AND** SHALL NOT be recorded as a completed quality failure of the treatment's design choices alone

---

### Requirement: Multi-change experiments SHALL support bare and pipeline treatments under one experiment without requiring #575

The runner SHALL accept multi-change experiment manifests that include at least a minimal bare or just-solve treatment and a current Agent Pipeline treatment for the same multi-change fixtures and models. Optional variants (adversarial review, deterministic quality feedback, #575 controls) SHALL be selectable without changing checkpoint prompts or verifiers. When #575 is not configured, the runner SHALL still execute bare-versus-pipeline multi-change experiments.

#### Scenario: Bare versus pipeline matrix expands

- **WHEN** a multi-change manifest names bare and pipeline-current treatments for a multi-change fixture
- **THEN** plan expansion SHALL produce distinct cells for each treatment against that fixture

#### Scenario: Missing #575 does not reject baseline

- **WHEN** a multi-change manifest requests only bare and pipeline-current treatments and #575 is unconfigured
- **THEN** manifest validation and execution SHALL proceed without requiring #575
