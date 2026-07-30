## ADDED Requirements

### Requirement: Summary output for named-pair experiments SHALL include pair-loop diagnostics

When summarizing an experiment whose treatments are named ordered pairs, the report SHALL
include, for each pair treatment, the pair identity (treatment id), whether fix was invoked
(and which fix rounds when available), blocking-finding counts before and after applicable
fix rounds, malformed/unparseable review counts, quality metrics, duration metrics, and
reliability (completion and failure-class) rates. Pair treatments SHALL remain comparable by
`treatment_id` against a declared baseline exactly as Cartesian treatments are.

#### Scenario: Pair identity appears in the summary

- **WHEN** `summary.json` is produced for a named-pair experiment
- **THEN** each pair treatment entry SHALL name the pair's treatment id

#### Scenario: Fix and blocking-finding diagnostics are present

- **WHEN** a pair treatment has completed cells that invoked fix
- **THEN** the summary SHALL report that fix was invoked for those cells' aggregate
- **AND** SHALL report blocking-finding counts before and after fix when those counts were
  recorded on the cells

#### Scenario: Malformed review counts are present

- **WHEN** completed pair cells record unparseable review steps
- **THEN** the summary SHALL report a malformed/unparseable review count for that treatment
- **AND** SHALL NOT treat those steps as approvals in quality aggregation

#### Scenario: Quality, duration, and reliability remain present

- **WHEN** the summary for a named-pair experiment is read
- **THEN** each pair treatment SHALL report quality, duration, and reliability rates using
  the same metric definitions as non-pair experiments
