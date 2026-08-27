## MODIFIED Requirements

### Requirement: The `queue` sub-command SHALL select only eligible issues for autonomous batch processing

The `queue` handler SHALL fetch only issues that are currently in an autonomous-eligible label state (e.g. `pipeline:ready` or equivalent as configured) from the GitHub backlog. Issues in any other pipeline label state, including `pipeline:needs-spec` and `pipeline:backlog`, SHALL be excluded from the batch and counted as `excluded` in the summary. The handler SHALL further filter the eligible set by the caller-supplied filters: `--label` (intersection of label values; repeatable), `--milestone` (exact milestone title match), and `--risk` (issue risk classification at or below the specified level). After filtering, the handler SHALL rank the remaining issues by a deterministic priority score and select the top `--max-issues` for dispatch. The priority score formula SHALL be a static constant defined in `queue.ts`, auditable without a model call.

#### Scenario: Non-eligible issues are excluded

- **WHEN** the GitHub backlog contains 4 issues with `pipeline:review-1` and 3 issues with `pipeline:ready`
- **THEN** the handler SHALL include only the 3 `pipeline:ready` issues in the candidate set
- **AND** the batch summary SHALL report 4 issues as `excluded`

#### Scenario: needs-spec issues are not autonomous-eligible

- **WHEN** the GitHub backlog contains 2 issues with `pipeline:needs-spec` and 3 issues with `pipeline:ready`
- **THEN** the handler SHALL include only the 3 `pipeline:ready` issues in the candidate set
- **AND** the batch summary SHALL report the 2 `pipeline:needs-spec` issues as `excluded`

#### Scenario: Label filter narrows the eligible set

- **WHEN** `--label team:backend` is passed and 2 of 5 eligible issues carry `team:backend`
- **THEN** only the 2 matching issues SHALL enter the candidate set for dispatch

#### Scenario: `--max-issues` caps the batch size

- **WHEN** 20 issues are eligible and pass all filters and `--max-issues 5` is set
- **THEN** the handler SHALL start pipeline runs for exactly 5 issues, ranked by priority score, and SHALL NOT launch runs for the remaining 15

#### Scenario: All filters applied together

- **WHEN** `--label risk:low --milestone v2.0 --max-issues 3` are all specified
- **THEN** only issues carrying `risk:low` AND belonging to milestone `v2.0` SHALL enter the candidate set, and at most 3 SHALL be dispatched

## ADDED Requirements

### Requirement: A queue pickup SHALL run the shared issue-readiness gate and SHALL NOT abort independent siblings on rejection

When `issue_readiness.enabled` is `true`, each selected `pipeline:ready` issue SHALL pass through the shared issue-implementation-readiness gate at dispatch, using a freshly fetched title and body rather than the queue inventory snapshot. A `needs_spec` result SHALL be recorded as a structured rejection in the batch summary and SHALL NOT mark the batch as a handler crash. Independent remaining selected issues SHALL continue. A `gate-unavailable` result SHALL block that issue and its selected dependents and SHALL leave independent selected issues eligible.

#### Scenario: Inventory snapshot is not the evaluated body

- **WHEN** queue inventory captured body text B0
- **AND** the live GitHub body at dispatch is B1
- **THEN** the gate SHALL evaluate B1

#### Scenario: One needs_spec rejection does not stop the batch

- **WHEN** a selected issue is rejected as `needs_spec` and other selected issues remain eligible
- **THEN** the batch summary SHALL name the structured `needs_spec` reason for the rejected issue
- **AND** the handler SHALL continue launching or completing the remaining independent issues
- **AND** the handler SHALL NOT exit solely because of that rejection
