# eval-multi-change-maintainability Specification

## Purpose
TBD - created by archiving change eval-multi-change-maintainability-fixtures. Update Purpose after archive.
## Requirements
### Requirement: Multi-change maintainability evaluation SHALL measure successive changes against persistent repository state

The evaluation system SHALL support multi-change maintainability fixtures in which an ordered series of realistic requirements is applied sequentially against persistent repository state for a single treatment lineage. Each checkpoint SHALL disclose only its own next requirement to the treatment. The primary correctness outcome SHALL be cumulative strict pass at each checkpoint and terminal all-green completion of the full sequence, not single-checkpoint success alone.

#### Scenario: Ordered checkpoints share repository lineage

- **WHEN** a multi-change fixture with checkpoints C1 then C2 is executed for a treatment
- **THEN** C2 SHALL run against the repository state produced by that treatment at the end of C1
- **AND** C2 SHALL NOT restart from the fixture `base_commit` as if C1 never ran

#### Scenario: Only the current requirement is disclosed

- **WHEN** checkpoint Ck executes
- **THEN** the treatment-visible prompt and inputs for Ck SHALL include Ck's disclosed requirement
- **AND** SHALL NOT include the full text of later checkpoints' requirements

---

### Requirement: Each checkpoint SHALL run with fresh model context while preserving the evidence contract

For each checkpoint in a multi-change lineage the runner SHALL start a fresh model or session context so prior conversation is not available. The runner SHALL preserve repository state and only the declared pipeline evidence artifacts between checkpoints. Hidden verifiers, grader internals, and free-form prior chat SHALL NOT be preserved into the next treatment context.

#### Scenario: Fresh context between checkpoints

- **WHEN** checkpoint C2 starts after C1 in the same lineage
- **THEN** the model or session context for C2 SHALL NOT include C1 conversation history

#### Scenario: Declared evidence is preserved

- **WHEN** a treatment produces in-contract pipeline evidence during C1
- **THEN** that declared evidence SHALL be available to C2 according to the evidence contract
- **AND** held-out verifier definitions SHALL remain unavailable to the treatment at C2

---

### Requirement: Held-out verifiers and inherited regression checks SHALL define strict checkpoint pass

Each checkpoint SHALL declare deterministic held-out verifiers for its newly requested behavior. At checkpoint k the evaluation system SHALL also re-run every held-out verifier declared by checkpoints 1..k-1 (the inherited set). A checkpoint SHALL pass strictly only when its new verifiers and every inherited verifier pass. Held-out verifiers SHALL NOT appear in treatment-visible inputs, prompts, or preserved evidence.

#### Scenario: Strict pass requires new and inherited green

- **WHEN** checkpoint C2's new verifiers pass but a C1 inherited verifier fails
- **THEN** C2 SHALL NOT be recorded as a strict pass

#### Scenario: Held-out verifiers stay hidden

- **WHEN** any checkpoint treatment is invoked
- **THEN** no treatment-visible input SHALL contain the bodies or commands of held-out verifiers for that fixture

#### Scenario: Inherited set is the prior union

- **WHEN** checkpoint C3 runs
- **THEN** the inherited verifier set SHALL equal the union of held-out verifiers from C1 and C2

---

### Requirement: Defect reports SHALL distinguish current-step, inherited, accumulated, recovered, and terminal states

Multi-change evaluation results SHALL report, for each checkpoint and for the lineage terminal state: current-step defects (failed new verifiers), inherited defects (failed inherited verifiers), accumulated unresolved defects, recovered defects (previously failing verifier ids that now pass), and whether the lineage ends terminal all-green. An early non-strict checkpoint SHALL NOT erase later checkpoint diagnostic records when the lineage continues.

#### Scenario: Early failure preserves later diagnostics

- **WHEN** C1 fails strictly and C2 later runs and recovers C1's verifier while introducing a new failure
- **THEN** the report SHALL record C1's failure, C2's recovery of the C1 defect id, and C2's current-step defect
- **AND** SHALL NOT omit C2's record because C1 failed

#### Scenario: Terminal all-green is explicit

- **WHEN** every verifier in the full inheritance closure passes after the final checkpoint
- **THEN** the lineage SHALL be reported as terminal all-green
- **AND** when any verifier still fails, terminal all-green SHALL be false

---

### Requirement: Treatment comparison SHALL hold prompts and verifiers constant

Multi-change maintainability experiments that claim treatment comparison SHALL run the same checkpoint prompts, repository base, and deterministic verifiers through at least a minimal bare or “just solve” treatment and the current Agent Pipeline treatment for the same model identity (except where a portability probe intentionally changes model at a marked checkpoint). Controlled variants (adversarial review enabled, deterministic code-quality feedback, and #575 design-dossier or human-attestation controls when configured risk policy fires) SHALL reuse the same benchmark contract. Absence of #575 configuration SHALL NOT prevent bare-versus-pipeline execution.

#### Scenario: Bare and pipeline share the benchmark contract

- **WHEN** a baseline multi-change experiment declares bare and pipeline-current treatments
- **THEN** both treatments SHALL receive identical per-checkpoint disclosed prompts and identical held-out verifier sets

#### Scenario: Optional #575 does not gate the baseline

- **WHEN** #575 design-dossier or human-attestation controls are not configured
- **THEN** the bare-versus-pipeline multi-change experiment SHALL still be runnable
- **AND** the #575 variant SHALL be omitted rather than failing the experiment as a hard dependency

#### Scenario: Controlled variants keep prompts and verifiers fixed

- **WHEN** an adversarial-review or quality-feedback variant is included
- **THEN** its checkpoint prompts and held-out verifiers SHALL match the baseline treatments

---

### Requirement: Reports SHALL separate correctness, effort, growth, and structural telemetry without a synthetic ground-truth score

Multi-change reports SHALL present per-change and cumulative correctness (including strict pass and defect states), time, tokens, cost, retries, human interventions, code growth, change amplification, and deterministic structural telemetry (such as complexity, duplication, dependency cycles, nesting, symbol churn, and single-use wrappers) as separate dimensions. The system SHALL NOT present a single model-judged score or a single collapsed structural “slop” or maintainability score as ground truth for maintainability.

#### Scenario: Structural telemetry is not pass/fail truth

- **WHEN** a multi-change lineage report is produced
- **THEN** structural telemetry fields SHALL appear as non-ground-truth signals
- **AND** the report SHALL NOT emit a single combined maintainability or slop score that replaces verifier-based correctness

#### Scenario: Effort and correctness are both visible

- **WHEN** two treatments have equal terminal correctness but different token cost
- **THEN** the report SHALL show both correctness and cost dimensions
- **AND** SHALL NOT hide the cost difference inside a single ranked score

---

### Requirement: The corpus SHALL include shortcut-debt, portability probe, and external canary coverage

The multi-change maintainability corpus SHALL include: (1) at least one fixture sequence where an initially test-passing shortcut at an early checkpoint materially increases later change cost or inherited-verifier failure risk; (2) at least one fixture that performs a stronger-to-weaker (or stronger-to-cheaper) model portability probe after checkpoints 1..N and reports the weaker model's correctness, time, cost, and intervention; (3) at least one curated external canary using the incrementally disclosed, inherited-regression shape; and (4) repo-native sequence content with architectural ambiguity and cross-cutting constraints representative of Agent Pipeline users' work.

#### Scenario: Shortcut-debt fixture is present

- **WHEN** the multi-change corpus is loaded
- **THEN** at least one fixture SHALL be identifiable as demonstrating early test-passing shortcut debt with later inherited or amplification pressure

#### Scenario: Portability probe reports weaker-model metrics

- **WHEN** a portability-probe checkpoint runs under a weaker or cheaper model after stronger-model prior checkpoints
- **THEN** the report SHALL include that checkpoint's correctness, time, cost, and intervention for the weaker or cheaper model

#### Scenario: External canary uses inheritance shape

- **WHEN** the curated external canary fixture is executed
- **THEN** it SHALL use ordered incremental disclosure and inherited verifier re-runs
- **AND** SHALL NOT rely on a single-shot full-spec dump as its only evaluation shape

