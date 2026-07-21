# roadmap-run-stats Specification

## Purpose
TBD - created by archiving change roadmap-perf-observability. Update Purpose after archive.
## Requirements
### Requirement: `plan.json` SHALL include a `run_stats` object recording per-phase timing and harness call counts

After a successful roadmap run, `plan.json` SHALL contain a top-level `run_stats` object with the following fields: `open_issue_count` (integer — total open issues before label filtering), `filtered_issue_count` (integer — issues remaining after label filtering), `inventory_harness_calls` (integer — number of harness calls actually made in phase 2), `inventory_harness_skipped` (integer — issues where the regex path produced results and the harness was not called), `depgraph_candidates_textual` (integer), `depgraph_candidates_shared_file` (integer), `depgraph_candidates_cross_file` (integer), `depgraph_verify_calls` (integer — verification calls made), `depgraph_verify_skipped` (integer — candidates skipped due to the verify cap), `critique_rounds` (integer — correction rounds executed in phase 7), and `phase_elapsed_ms` (an object mapping each phase name to its elapsed time in milliseconds). All fields SHALL be present and non-negative integers (or a non-negative-valued object for `phase_elapsed_ms`). The `run_stats` key SHALL NOT be required by existing consumers of `plan.json` (it is additive).

#### Scenario: Completed run contains run_stats

- **WHEN** `pipeline roadmap` completes successfully
- **THEN** `plan.json` SHALL contain a `run_stats` object with all required sub-fields present and non-negative
- **AND** `run_stats.open_issue_count` SHALL be ≥ `run_stats.filtered_issue_count`

#### Scenario: phase_elapsed_ms covers all 7 phases

- **WHEN** `plan.json.run_stats.phase_elapsed_ms` is inspected
- **THEN** it SHALL contain an entry for each of: `comprehend`, `inventory`, `depgraph`, `score`, `roadmap`, `hygiene`, `critique`
- **AND** each value SHALL be a non-negative integer (milliseconds)

#### Scenario: Harness-skipped count reflects regex elision

- **WHEN** all filtered issues have unambiguous file paths in their bodies
- **THEN** `run_stats.inventory_harness_skipped` SHALL equal `run_stats.filtered_issue_count`
- **AND** `run_stats.inventory_harness_calls` SHALL equal 0

#### Scenario: Skipped-verification count reflects cap

- **WHEN** the total ranked candidate count exceeds `roadmap.depgraph_verify_cap`
- **THEN** `run_stats.depgraph_verify_skipped` SHALL equal (total candidates − `depgraph_verify_cap`)
- **AND** `run_stats.depgraph_verify_calls` SHALL equal `depgraph_verify_cap`

#### Scenario: run_stats is additive and does not break existing plan.json consumers

- **WHEN** a plan.json consumer reads only `roadmap[]`, `dependency_graph`, `scored[]`, `hygiene[]`, `milestones[]`, `critique[]`, and `open_questions[]`
- **THEN** the addition of `run_stats` SHALL NOT require changes to that consumer
