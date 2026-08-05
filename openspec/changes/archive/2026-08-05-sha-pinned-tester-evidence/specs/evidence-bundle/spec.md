## ADDED Requirements

### Requirement: Run evidence surfaces SHALL persist full Tester evidence

The pipeline SHALL persist the full structured `TesterEvidence` record in the
run evidence surfaces under the existing run directory layout when that record
is produced for a run (for example a dedicated file such as
`tester-evidence.json` and/or inclusion in `summary.json`), and SHALL append a
structured event to `events.jsonl` that references or embeds the Tester outcome
fields needed by consumers. Persistence SHALL apply the same secret-redaction
and injection-denylist rules as other evidence-bundle string fields. A human
summary comment, when posted, is not a substitute for the full structured
record.

#### Scenario: full record present in the run directory after production

- **WHEN** the deterministic producer writes Tester evidence for run `R`
- **THEN** the run directory for `R` SHALL contain the full structured
  `TesterEvidence` record (dedicated file and/or `summary.json` field)
- **AND** the persisted payload SHALL include `candidate_sha`,
  `overall_status`, `commands`, and timing fields

#### Scenario: events.jsonl carries a tester evidence signal

- **WHEN** Tester evidence is successfully written for a run
- **THEN** `events.jsonl` SHALL include an event that identifies the Tester
  outcome (at least overall status, candidate SHA, and duration or equivalent)
- **AND** consumers SHALL NOT need to parse a GitHub comment to learn that
  status

#### Scenario: write failure does not pretend success

- **WHEN** persisting Tester evidence fails after a suite run
- **THEN** the pipeline SHALL surface an operator-visible write-health or
  artifact-write failure signal consistent with existing run-store write-health
  dispositions
- **AND** SHALL NOT claim that the full structured record was stored when it
  was not

#### Scenario: secrets are not stored in the bundle form

- **WHEN** Tester command output contains a secret matching redaction rules
- **THEN** the evidence-bundle copy of the Tester record SHALL contain the
  redacted placeholder
- **AND** SHALL NOT contain the raw secret value
