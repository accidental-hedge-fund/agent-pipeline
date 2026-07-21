## ADDED Requirements

### Requirement: Stage accounting records capture the resolved reasoning effort

A stage accounting record SHALL include an optional `effort` field carrying the reasoning
effort that was actually resolved for that invocation — the value the pipeline passed to
the harness as `--effort` or `model_reasoning_effort` — so that the effort dimension is a
recorded identity rather than a value inferred at report time.

The field SHALL be additive and optional: it SHALL be written when an effort was resolved
for the invocation, SHALL be omitted or `null` when none was, and SHALL NOT be written as
a fabricated default. Adding it SHALL NOT add or remove any required field, and readers
SHALL continue to accept records written before this field existed. The effort value
SHALL NOT be reconstructed from the current configuration when reading historical
records, because the configuration may have changed since those records were written.

#### Scenario: A stage with a resolved effort records it

- **WHEN** a stage invokes a harness with a resolved reasoning effort
- **THEN** the resulting stage accounting record SHALL carry that effort value verbatim in
  its `effort` field

#### Scenario: A stage with no resolved effort omits the field

- **WHEN** a stage invokes a harness without any resolved reasoning effort
- **THEN** the resulting stage accounting record SHALL omit `effort` or set it to `null`
- **AND** it SHALL NOT record a substituted or default effort value

#### Scenario: Records written before the field remain readable

- **WHEN** a reader processes a stage accounting record that predates the `effort` field
- **THEN** the record SHALL parse successfully with every other field unchanged
- **AND** the reader SHALL treat the missing effort as unknown rather than as a value
