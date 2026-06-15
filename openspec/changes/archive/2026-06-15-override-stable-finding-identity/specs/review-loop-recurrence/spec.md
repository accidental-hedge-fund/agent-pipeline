## MODIFIED Requirements

### Requirement: Early park when a blocking finding recurs after a fix round
When a review round returns blocking findings and at least one finding's `findingKey` matches a blocking key present in the immediately-prior Review-N comment for the same round number, the pipeline SHALL transition to `needs-human` immediately — without consuming additional round budget — and SHALL post the ceiling punch-list comment with RECURRING/NEW tags.

A finding whose `severity`, `file`, or line band changes carries a different `findingKey` and SHALL be treated as a new finding (no early park on its account alone). A finding whose title changes but whose severity, file, and line location (within the same 5-line band) are unchanged SHALL carry the same `findingKey` and SHALL be treated as a recurring finding.

#### Scenario: Exact key re-appear after a fix — early park
- **WHEN** a review round (round N) returns a `needs-attention` verdict with blocking findings
- **AND** the immediately-prior Review-N comment contains `` `override-key: <key>` `` for at least one of those blocking findings
- **THEN** the pipeline SHALL immediately transition to `needs-human`
- **AND** SHALL post the punch-list comment (with RECURRING/NEW tags) before transitioning
- **AND** SHALL NOT consume additional round budget (remaining `max_adversarial_rounds` is irrelevant)
- **AND** the transition SHALL be identical in authority to the ceiling-triggered `needs-human` (no auto-advance)

#### Scenario: All blocking findings are new — no early park
- **WHEN** a review round returns `needs-attention` with blocking findings
- **AND** none of those findings' `findingKey` values appear in the immediately-prior Review-N comment
- **THEN** the pipeline SHALL continue normally (route to fix stage or ceiling as before)
- **AND** SHALL NOT early-park

#### Scenario: No prior Review-N comment — no early park
- **WHEN** a review round returns `needs-attention` with blocking findings
- **AND** no prior Review-N comment exists in `detail.comments` for that round number
- **THEN** the pipeline SHALL continue normally without recurrence checking
- **AND** SHALL NOT early-park

#### Scenario: Title rewording at same location — treated as recurring
- **WHEN** a blocking finding from round N is re-emitted in round N+1 with a reworded title
- **AND** the finding's severity, file, and line location (within the same 5-line band) are unchanged
- **THEN** `findingKey` SHALL return the same key for both emissions
- **AND** the pipeline SHALL treat the round N+1 finding as a recurrence (not a new finding)
- **AND** SHALL early-park at `needs-human` if the prior round's blocking keys include this key

#### Scenario: Severity or file/location change — new key, no early park
- **WHEN** a finding from a prior round is re-emitted with a changed `severity`, a different `file`, or a `line_start` that falls in a different 5-line band (producing a different `findingKey`)
- **THEN** the pipeline SHALL treat it as a new finding
- **AND** SHALL NOT count it as a recurrence for the early-park trigger
