## ADDED Requirements

### Requirement: In-flight ship FRG scoring SHALL attach candidate-bound #1333 executed rows from a complete matrix inventory

When Factory Reliability Gate unique-operation scoring runs as a phase of an admitted in-flight `ship`, scoring SHALL attach `executed_matrix_rows` bound to the scored candidate SHA from the candidate tree's fault-recovery matrix inventory when the inventory-completeness guard passes for that tree. Those rows SHALL feed `covered_lifecycle_classes` through the existing executed-row binder. Scoring SHALL NOT stamp helper `covered_lifecycle_classes` lists. An incomplete inventory SHALL NOT attach rows. Standalone factory-gate scoring SHALL NOT mint inventory rows. Absence of durable executed rows on standalone factory-gate SHALL fail as missing required coverage.

#### Scenario: Complete inventory covers all five #1333 classes for the scored SHA

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard passes
- **THEN** unique-operation evidence SHALL cover lifecycle classes `mechanical`, `workflow`, `infrastructure`, `authentication`, and `unknown` from inventory rows bound to `C`
- **AND** helper `covered_lifecycle_classes` stamps SHALL NOT populate that coverage

#### Scenario: Incomplete inventory does not mint #1333 coverage

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard fails
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase for uncovered #1333 classes

#### Scenario: Standalone factory-gate does not mint inventory rows

- **WHEN** standalone factory-gate unique-operation scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent
- **THEN** scoring SHALL NOT attach inventory rows
- **AND** missing required coverage SHALL increase

## MODIFIED Requirements

### Requirement: Ship FRG unique-operation scoring SHALL use control-host durable evidence bound to the scored candidate

Ship FRG unique-operation scoring SHALL collect unique-operation attempts and #1301 live train-loop linkage from the control-host generic run store used for train, advance, and merge (`<control-repo>/.agent-pipeline/runs`) and from the loop state-home runs root. Followable `train_loop_linked` child run, event, and handoff paths SHALL resolve inside those control-host roots; a path that escapes into the candidate worktree SHALL NOT be loaded as unique-operation evidence. It SHALL NOT treat an empty candidate-worktree `.agent-pipeline/runs` directory as proof that train, loop, merge, or merge-queue never ran. In-flight ship scoring SHALL keep unbound control-host attempts that lack `candidate_sha`. Standalone factory-gate scoring SHALL omit unbound attempts. In-flight ship scoring SHALL pass candidate-bound #1333 executed matrix rows through the existing unique-operation coverage seam, including rows attached from a complete candidate-tree inventory. GitHub pack-issue labels, comment prose, and factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) SHALL NOT substitute for unique-operation coverage. When the control-host generic store and the loop state-home are both empty of collectable train, loop, and merge evidence, unique-operation coverage SHALL fail closed as missing required coverage. This capability SHALL NOT add a second unique-operation aggregator, Factory Reliability Gate runner, or scheduler.

#### Scenario: Empty candidate-worktree run-store does not fail a host-proven ship

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host durable store has train, loop, and merge unique-operation evidence bound to `C`
- **AND** hybrid v2 pack proofs pass
- **THEN** FRG structural eligibility SHALL NOT fail solely because the candidate worktree run-store is empty
- **AND** `isReleaseEligibleFrgPass` with attestation optional SHALL be true when remaining unique-operation SLOs and bindings hold

#### Scenario: Empty candidate worktree plus populated generic host store observes required entrypoints under in-flight ship

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the candidate worktree `.agent-pipeline/runs` is empty
- **AND** the control-host generic run store has recognized public-entrypoint artifacts
- **THEN** required public entrypoints present in that generic store SHALL be observed
- **AND** FRG structural eligibility SHALL NOT fail solely because the loop state-home was the only root scanned

#### Scenario: Empty control-host store remains fail-closed

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host generic run store has no collectable train, loop, or merge unique-operation evidence
- **AND** the loop state-home has no collectable train, loop, or merge unique-operation evidence
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused
- **AND** pack-issue `pipeline:ready-to-deploy` labels SHALL NOT satisfy that coverage

#### Scenario: Empty control-host store remains fail-closed when candidate-worktree artifacts match

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host generic run store has no collectable train, loop, or merge unique-operation evidence
- **AND** the loop state-home has no collectable train, loop, or merge unique-operation evidence
- **AND** the candidate worktree `.agent-pipeline/runs` has matching unique-operation attempts and executed-matrix rows bound to `C`
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused

#### Scenario: Pack proofs are not unique-operation substitutes

- **WHEN** factory-gate 2-item pack proofs (clean-docs, clean-openspec, hybrid v2 Layer A) pass
- **AND** durable unique-operation evidence collectable from the control-host stores is absent
- **THEN** release-eligible pass SHALL be refused
- **AND** the integrity report SHALL name missing required coverage, not a stable exclusion

#### Scenario: #1333 rows come from control-host or engine evidence for the candidate

- **WHEN** ship FRG unique-operation scoring runs for candidate SHA `C`
- **AND** executed matrix rows bound to `C` exist in control-host or engine evidence
- **THEN** those rows SHALL feed #1333 `covered_lifecycle_classes` through the existing binder
- **AND** helper stamps and pack labels SHALL NOT populate that coverage

#### Scenario: In-flight ship #1333 rows may come from a complete candidate-tree inventory

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** durable executed matrix rows bound to `C` are absent from host run artifacts
- **AND** the candidate tree's fault-recovery matrix inventory-completeness guard passes
- **THEN** inventory rows bound to `C` SHALL feed #1333 `covered_lifecycle_classes` through the existing binder
- **AND** helper stamps SHALL NOT populate that coverage
- **AND** absence of a complete inventory SHALL fail as missing required coverage

#### Scenario: Candidate-worktree child handoff does not satisfy host #1301 linkage

- **WHEN** a ship FRG pack is scored for candidate SHA `C`
- **AND** the control-host train stream bound to `C` carries `train_loop_linked` whose events path resolves in the candidate worktree
- **AND** that child run exists only in the candidate worktree
- **THEN** that child SHALL NOT be loaded as unique-operation evidence
- **AND** #1301 live train-loop linkage SHALL NOT be treated as present from that handoff
- **AND** release-eligible pass SHALL be refused

#### Scenario: Candidate-only host artifacts without release identity remain fail-closed

- **WHEN** standalone factory-gate scoring runs for candidate SHA `C` and release identity `R`
- **AND** the control-host store has unique-operation artifacts bound to `C` with no durable release identity
- **THEN** unique-operation coverage SHALL fail as missing required coverage
- **AND** release-eligible pass SHALL be refused

#### Scenario: In-flight ship keeps unbound host artifacts that lack candidate SHA

- **WHEN** in-flight ship FRG scoring runs for candidate SHA `C`
- **AND** the control-host generic run store has train and loop artifacts with no `candidate_sha`
- **THEN** those artifacts SHALL be kept as unique-operation attempts
- **AND** entrypoint coverage SHALL observe `train` and `loop`

---

### Requirement: Factory-release structural eligibility failure SHALL name unique-operation SLO or binding failure

When `factory-release prepare` refuses structural eligibility because unique-operation SLOs or unique-operation release bindings fail, the hard-gate message SHALL include the unique-operation SLO failure string or the unique-operation release-binding failure string. A generic structural-eligibility sentence without that string SHALL NOT be the only diagnostic when unique-operation validation is the defect. When `defect_class` is `frg_not_eligible` and those diagnostics exist, the message SHALL NOT equal only the bare fallback sentence `FRG structural eligibility failed for <version>. Hard gate: release preparation blocked.` HMAC attestation on the tag and promote path SHALL remain required.

#### Scenario: Unique-operation SLO failure is named on the hard gate

- **WHEN** hybrid v2 pack proofs pass
- **AND** unique-operation SLO validation returns a failure string
- **AND** `factory-release prepare` scores that pack as not structurally eligible
- **THEN** the hard-gate message SHALL include that unique-operation SLO failure string
- **AND** the command SHALL NOT return `status: "complete"`

#### Scenario: Unique-operation binding failure is named on the hard gate

- **WHEN** unique-operation release-binding validation returns a failure string
- **AND** `factory-release prepare` scores that pack as not structurally eligible
- **THEN** the hard-gate message SHALL include that binding failure string

#### Scenario: Bare fallback sentence is not the only diagnostic

- **WHEN** `factory-release prepare` returns `defect_class` `frg_not_eligible`
- **AND** unique-operation SLO or release-binding validation returns a non-null diagnostic string
- **THEN** the hard-gate message SHALL include that diagnostic string
- **AND** the message SHALL NOT equal only `factory-release prepare: FRG structural eligibility failed for <version>. Hard gate: release preparation blocked.`
