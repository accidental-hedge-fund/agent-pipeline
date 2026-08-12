## ADDED Requirements

### Requirement: Pre-merge consumers SHALL refuse fail authority from SHA-mismatched Tester evidence

When pre-merge (or any pre-merge sub-gate) loads `TesterEvidence` to decide suite pass/fail or exhaustion, acquisition SHALL compare `artifact.candidate_sha` to the live open PR head pin for that evaluation. On mismatch, the evidence SHALL be classified stale (or non-current) exactly as for review acquisition. Stale evidence with a non-pass `overall_status` SHALL NEVER supply fail authority for the live head: the pipeline SHALL NOT treat that artifact as proving the live head suite failed, and SHALL NOT escalate to `test-gate-exhausted` / suite-fail `needs-human` solely from it. Stale evidence SHALL also NEVER be presented as a suite pass for the live head (existing non-pass-on-mismatch rule is preserved).

#### Scenario: Mismatched fail evidence is stale and not live-head fail

- **WHEN** pre-merge loads Tester evidence whose `candidate_sha` is `H_fail`
- **AND** the live open PR head pin is `H_green` where `H_fail ≠ H_green`
- **AND** the record’s `overall_status` is a non-pass class (e.g. `failed`)
- **THEN** acquisition SHALL classify the evidence as stale or non-current for `H_green`
- **AND** pre-merge SHALL NOT treat the live head suite as failed solely from that artifact

#### Scenario: Matching fail evidence remains authoritative for that head

- **WHEN** pre-merge loads well-formed Tester evidence whose `candidate_sha` equals the live head pin H
- **AND** `overall_status` is `failed` (or another non-pass class that blocks under policy)
- **THEN** acquisition SHALL treat the evidence as current for H
- **AND** pre-merge MAY apply existing suite-fail / recovery / block dispositions for H

#### Scenario: Matching pass evidence remains current

- **WHEN** pre-merge loads well-formed Tester evidence whose `candidate_sha` equals the live head pin H
- **AND** `overall_status` is `passed`
- **THEN** acquisition SHALL treat the evidence as current for H
- **AND** SHALL NOT invent a fail from older mismatched records when this record is current
