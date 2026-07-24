## ADDED Requirements

### Requirement: Comparative reporting MAY link trajectory artifacts for flagged cells without changing default output

Comparative reporting SHALL remain unchanged by default: with trajectory linking disabled, the
summary output SHALL be byte-identical to the output produced without this capability. When linking
is enabled, the report MAY attach trajectory and verifier artifact references for flagged cells —
outliers, judge disagreements, false positives, false negatives, and failed cells — as additive
references. Linking SHALL NOT change any aggregate, effect, interval, or grouping in the summary,
and summarizing the same grades twice with linking enabled SHALL produce byte-identical output.

#### Scenario: Default output is unchanged when linking is disabled

- **WHEN** the summary is produced with trajectory linking disabled
- **THEN** its bytes SHALL be identical to the summary produced without this capability

#### Scenario: Enabled linking adds references only for flagged cells

- **WHEN** the summary is produced with trajectory linking enabled
- **THEN** it MAY include treatment and verifier artifact references for outliers, judge
  disagreements, false positives, false negatives, and failed cells
- **AND** no aggregate, effect, confidence interval, or grouping value SHALL change relative to the
  linking-disabled summary

#### Scenario: Linked summarization is deterministic

- **WHEN** the same grade stream is summarized twice with trajectory linking enabled
- **THEN** the two summary outputs SHALL be byte-identical
