## ADDED Requirements

### Requirement: Ensemble agents SHALL share one SHA-matched Tester evidence record

The engine SHALL give every agent for a review round the same authoritative
Tester evidence section for the candidate under review when `review_ensemble`
is enabled and the round fans out to N agents at the shared reviewer invoke
seam (identical SHA-matched artifact or identical explicit stale/unavailable
classification). Agents SHALL NOT each produce or rewrite the authoritative
`TesterEvidence` record. Optional identity/role suffixes MAY differ per agent;
the Tester suite evidence block SHALL NOT.

#### Scenario: two ensemble agents see identical authoritative suite evidence

- **WHEN** ensemble is enabled with two agents for a review round on candidate
  SHA `S`
- **AND** trustworthy Tester evidence exists for `S`
- **THEN** both agent prompts SHALL include the same authoritative Tester
  overall status and candidate SHA for `S`
- **AND** neither agent’s prompt SHALL omit the section while the other
  receives it

#### Scenario: ensemble does not create per-agent authoritative suite records

- **WHEN** ensemble agents complete a review round
- **THEN** the pipeline SHALL retain a single authoritative `TesterEvidence`
  record for the candidate
- **AND** SHALL NOT replace it with per-agent suite re-runs as the authority

#### Scenario: stale classification is shared across the fan-out

- **WHEN** only stale Tester evidence is available for the candidate
- **AND** ensemble fans out to N agents
- **THEN** every agent SHALL receive the same stale/unavailable classification
- **AND** no agent SHALL be told the suite passed based on the stale artifact
