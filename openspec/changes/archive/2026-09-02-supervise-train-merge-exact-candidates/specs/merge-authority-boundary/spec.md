## ADDED Requirements

### Requirement: Candidate-bound merge authorization SHALL be re-derived after candidate movement

Operator invocation SHALL authorize only the frozen train, merge-queue, or per-PR scope named by the original typed envelope (`pipeline merge <pr>`, `pipeline merge-queue --apply`, or `pipeline train --merge`). Candidate-bound merge authorization SHALL be derived only after exact-candidate gates pass for the current inspected head. A moved head, changed base, changed PR identity, or changed frozen issue scope SHALL invalidate that derived authorization. The original envelope SHALL NOT be widened. Repository configuration SHALL NOT authorize merges.

#### Scenario: Resume uses the original envelope

- **WHEN** a train `--merge` or merge-queue `--apply` process resumes after crash
- **THEN** merge authorization SHALL remain the original operator invocation
- **AND** it SHALL NOT be replaced by host retry, recover-parked, or `.github/pipeline.yml`

#### Scenario: Head movement drops derived authorization only

- **WHEN** the inspected head of an authorized PR moves
- **THEN** candidate-bound merge authorization SHALL be invalid
- **AND** the original operator envelope SHALL still name the same frozen scope
- **AND** merge SHALL proceed only after a new exact-candidate gate pass

#### Scenario: Changed base drops derived authorization only

- **WHEN** the live PR `baseRefName` differs from the configured base on the claim
- **THEN** candidate-bound merge authorization SHALL be invalid
- **AND** the original operator envelope SHALL still name the same frozen scope
- **AND** merge SHALL NOT target the retargeted base

#### Scenario: Repository config still cannot authorize merge

- **WHEN** a repository sets any merge-related key in `.github/pipeline.yml`
- **THEN** that key SHALL NOT grant merge authority
- **AND** `auto_merge` SHALL remain an unknown config key
