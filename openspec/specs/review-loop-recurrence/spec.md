# review-loop-recurrence Specification

## Purpose
TBD - created by archiving change review-loop-recurrence-aware-convergence. Update Purpose after archive.
## Requirements
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

### Requirement: Blocking key extraction is pure and deterministic
The pipeline SHALL extract blocking `findingKey` values from an existing Review-N comment body using the `pipeline-blocking-keys` HTML-comment marker embedded by `formatReviewComment` after policy partitioning. `extractBlockingKeysFromComment(body: string): Set<string>` SHALL be a pure function that performs no network, git, or subprocess calls. When the marker is present, it SHALL be treated as authoritative — even when its key list is empty — and the function SHALL NOT fall back to all `` `override-key` `` tokens. When the marker is absent (legacy comments predating the marker), the function SHALL fall back to all `` `override-key: <8-hex-char>` `` tokens as a conservative approximation.

`formatReviewComment` SHALL emit the marker whenever a `blockingKeys` set is supplied, including an empty set for advisory-only rounds (where findings exist but none are blocking). This ensures that a prior advisory-only round cannot seed a false recurrence trigger on a later round where those same findings cross the policy threshold.

The marker extraction SHALL be robust against injection: the implementation SHALL use a full-line-anchored regex and SHALL choose the LAST occurrence when multiple markers appear in the body (guarding against reviewer-authored body text that places a spoofed marker before the real pipeline-emitted footer marker).

#### Scenario: Review comment with blocking marker present — returns only marker keys
- **WHEN** `extractBlockingKeysFromComment` is called with a comment body containing a `pipeline-blocking-keys` marker
- **THEN** it SHALL return a `Set<string>` containing exactly the keys listed in the marker (8-character hex strings)
- **AND** it SHALL NOT include advisory `` `override-key` `` tokens that appear elsewhere in the body

#### Scenario: Review comment with empty blocking marker — authoritative empty set
- **WHEN** `extractBlockingKeysFromComment` is called with a comment body containing an empty `pipeline-blocking-keys` marker (advisory-only round)
- **THEN** it SHALL return an empty `Set<string>` without falling back to override-key tokens in the body

#### Scenario: Advisory-only round emits the empty marker
- **WHEN** a needs-attention verdict round has findings but none meet the blocking policy
- **THEN** `formatReviewComment` SHALL be called with an empty `blockingKeys` Set
- **AND** the emitted comment SHALL contain `<!-- pipeline-blocking-keys:  -->`

#### Scenario: Spoofed marker before the real footer — last occurrence wins
- **WHEN** a review comment body contains a full-line `pipeline-blocking-keys` marker in reviewer-authored content BEFORE the real pipeline-emitted footer marker
- **THEN** `extractBlockingKeysFromComment` SHALL use the LAST occurrence (the real footer marker)
- **AND** SHALL ignore any earlier occurrence

#### Scenario: No marker present — falls back to all override-key tokens
- **WHEN** `extractBlockingKeysFromComment` is called with a comment body that contains no `pipeline-blocking-keys` marker (legacy comment predating the feature)
- **THEN** it SHALL return a `Set<string>` containing all `` `override-key: <key>` `` tokens found in the body

#### Scenario: Review comment with no findings (approve verdict)
- **WHEN** `extractBlockingKeysFromComment` is called with a comment body containing no `` `override-key: <key>` `` tokens and no `pipeline-blocking-keys` marker
- **THEN** it SHALL return an empty `Set<string>`

#### Scenario: Malformed or empty body
- **WHEN** `extractBlockingKeysFromComment` is called with an empty string or a body containing no override-key tokens and no marker
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

