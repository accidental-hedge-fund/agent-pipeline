# review-loop-recurrence Specification

## Purpose
Recurrence-aware convergence for the fix↔review loop: the pipeline SHALL park at `needs-human` immediately when a blocking finding re-appears with an unchanged `findingKey` after a fix round, rather than consuming the remaining `max_adversarial_rounds` budget. On the ceiling or recurrence-triggered punch-list, each finding SHALL be tagged `RECURRING (n rounds)` or `NEW` based on its history in prior Review-N comments.

## ADDED Requirements

### Requirement: Early park when a blocking finding recurs after a fix round
When a review round returns blocking findings and at least one finding's `findingKey` matches a blocking key present in the immediately-prior Review-N comment for the same round number, the pipeline SHALL transition to `needs-human` immediately — without consuming additional round budget — and SHALL post the ceiling punch-list comment with RECURRING/NEW tags.

A finding whose `severity` or `title` changes carries a different `findingKey` and SHALL be treated as a new finding (no early park on its account alone).

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

#### Scenario: Severity or title change — new key, no early park
- **WHEN** a finding from a prior round is re-emitted with a changed `severity` or `title` (producing a different `findingKey`)
- **THEN** the pipeline SHALL treat it as a new finding
- **AND** SHALL NOT count it as a recurrence for the early-park trigger

### Requirement: Blocking key extraction is pure and deterministic
The pipeline SHALL extract blocking `findingKey` values from an existing Review-N comment body by scanning for the `` `override-key: <8-hex-char>` `` pattern embedded by `formatReviewComment`. This extraction SHALL be implemented as a pure function `extractBlockingKeysFromComment(body: string): Set<string>` that performs no network, git, or subprocess calls.

#### Scenario: Review comment with findings
- **WHEN** `extractBlockingKeysFromComment` is called with a review comment body that contains one or more `` `override-key: <key>` `` tokens
- **THEN** it SHALL return a `Set<string>` containing exactly those keys (8-character hex strings)

#### Scenario: Review comment with no findings (approve verdict)
- **WHEN** `extractBlockingKeysFromComment` is called with a comment body containing no `` `override-key: <key>` `` tokens
- **THEN** it SHALL return an empty `Set<string>`

#### Scenario: Malformed or empty body
- **WHEN** `extractBlockingKeysFromComment` is called with an empty string or a body containing no override-key tokens
- **THEN** it SHALL return an empty `Set<string>` without throwing

### Requirement: RECURRING / NEW tags on the needs-human punch-list
The ceiling punch-list comment posted by `reviewCeilingComment` (and the recurrence-triggered early-park punch-list comment) SHALL tag each blocking finding as either `RECURRING (n rounds)` or `NEW`, where `n` is the count of prior Review-N comment bodies that contain `` `override-key: <key>` `` for that finding's key. The tagging SHALL be derived purely by set-membership against `detail.comments`; no model call SHALL be made.

#### Scenario: Finding present in prior rounds — tagged RECURRING
- **WHEN** the punch-list comment is assembled for a finding whose `findingKey` appears in at least one prior Review-N comment body
- **THEN** the finding's line SHALL include the tag `RECURRING (n rounds)` where `n` equals the count of prior Review-N comments containing that key

#### Scenario: Finding not present in any prior round — tagged NEW
- **WHEN** the punch-list comment is assembled for a finding whose `findingKey` does not appear in any prior Review-N comment body
- **THEN** the finding's line SHALL include the tag `NEW`

#### Scenario: No prior Review-N comments — all findings tagged NEW
- **WHEN** the punch-list comment is assembled and `detail.comments` contains no prior Review-N comments for the current round
- **THEN** every finding SHALL be tagged `NEW`

#### Scenario: Punch-list remains the authoritative needs-human output
- **WHEN** the recurrence-triggered or ceiling-triggered punch-list is posted
- **THEN** it SHALL include the same override instructions and resume steps as the existing ceiling punch-list
- **AND** the `needs-human` transition SHALL remain a true human gate (no auto-advance)
