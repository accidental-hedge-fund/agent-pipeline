## ADDED Requirements

### Requirement: Persisted review rounds SHALL record ensemble agent identities when ensemble ran

Persisted review rounds SHALL record multi-agent ensemble identity when a review round used review
ensemble. The persisted round record (inside existing run-directory artifacts `events.jsonl` and/or
`summary.json`) SHALL include, for each agent: configured harness, effective harness, model when
known, self_review boolean, usable/failed status, and cost when known, in addition to any single
effective-reviewer fields already required. The round SHALL also record ensemble size and a merge
summary sufficient for scoreboard and audit (merge mode union-blocking, usable count, failure
diagnostics). Fields SHALL be additive and optional so single-agent rounds remain valid without
ensemble keys, and `schema_version` SHALL NOT require a breaking bump solely for ensemble identity.

The persisted **finding** array for the round SHALL be the **merged** finding set only (one entry
per post-dedupe finding), each still carrying `key` equal to `findingKey(finding)` from
`review-policy.ts`.

#### Scenario: ensemble round lists every agent

- **WHEN** an ensemble review round completes with two agents (one self-review, one independent)
- **THEN** the persisted round SHALL list both agents with harness and self_review fields
- **AND** SHALL mark only the fallback agent as self-review

#### Scenario: findings array is the merged set

- **WHEN** two agents together produce five raw findings that dedupe to three keys
- **THEN** the persisted finding array for that round SHALL contain three records
- **AND** each record’s `key` SHALL equal `findingKey` for that merged finding

#### Scenario: single-agent rounds omit ensemble without breaking consumers

- **WHEN** a review round runs with ensemble disabled
- **THEN** the persisted round MAY omit ensemble agent arrays
- **AND** existing single effective-reviewer harness/model/self_review fields SHALL remain valid
- **AND** consumers that ignore unknown optional fields SHALL continue to work

#### Scenario: no new run-directory file for ensemble identity

- **WHEN** ensemble identity is persisted for a run
- **THEN** it SHALL be carried within `events.jsonl` and/or `summary.json`
- **AND** the run directory SHALL NOT require a new well-known file solely for ensemble identity
