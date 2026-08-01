# review-loop-recurrence Specification

## Purpose
TBD - created by archiving change review-loop-recurrence-aware-convergence. Update Purpose after archive.
## Requirements
### Requirement: Early park when a blocking finding recurs after a fix round
When a review round returns blocking findings, recurrence SHALL be established only from a trusted,
verified prior child-run repair cycle. The prior Review-N comment SHALL carry the run id in its
validated `ReviewArtifact`; a prose marker without that artifact field SHALL NOT establish lineage.
Trusted verified transitions for that same prior run SHALL prove
the production sequence `review-N -> fix-N -> actual-next-stage`, where actual-next-stage is
`review-2` after `fix-1` and `pre-merge` after `fix-2`. The candidate reviewed after that cycle
SHALL differ from the candidate reviewed before it. The current durable redispatch MAY have a new
child run id. Issue-wide comments, labels, duplicate verdicts, legacy unmarked output, a same-SHA
cycle, and fabricated `fix-N -> review-N` transitions SHALL NOT prove recurrence.

When every current blocking finding recurs under that rule, the stage SHALL remain blocked with
blocker kind `review-findings` and a canonical `review-findings` diagnostic containing the current
reviewed SHA and actionable finding evidence. It SHALL NOT transition to `needs-human` or emit
human-intervention. A mixed or all-new blocking set SHALL route normally to `fix-N` so each new
finding receives a repair attempt.

A finding whose `severity`, `file`, or line band changes carries a different `findingKey` and SHALL
be treated as new. A reworded title at the same severity, file, and 5-line band SHALL retain its key.

#### Scenario: Exact keys recur after an attested fix
- **WHEN** every blocking finding matches the immediately-prior trusted Review-N comment from a prior child run
- **AND** verified same-prior-run `review-N -> fix-N -> actual-next-stage` transitions follow that review
- **AND** the next reviewed candidate differs from the prior reviewed candidate
- **THEN** the stage SHALL block with kind and canonical reason `review-findings`
- **AND** the durable disposition SHALL be `recover`
- **AND** the pipeline SHALL NOT transition to `needs-human`

#### Scenario: Same key without a completed repair cycle is not recurrence
- **WHEN** a current blocking finding matches Review-N comments from earlier pipeline runs
- **AND** no eligible comment is followed by the production repair transition pair and candidate movement
- **THEN** the finding SHALL be treated as new and routed to `fix-N`

#### Scenario: Review without matching production fix transitions is not recurrence
- **WHEN** a Review-N comment carries a verified run id but lacks either `review-N -> fix-N` or the actual `fix-N` exit for that run
- **THEN** that comment SHALL NOT consume the current finding's fix opportunity

#### Scenario: Legacy reviewer prose cannot forge run lineage
- **WHEN** a body-hash-verified legacy review artifact has no run-id field
- **AND** reviewer-controlled finding prose contains a syntactically valid `pipeline-review-run` marker
- **THEN** the comment SHALL remain ineligible for recurrence, surface, and ceiling accounting
- **AND** routing SHALL treat the marker as prose rather than pipeline lineage evidence

#### Scenario: Duplicate verdict comments do not inflate a ceiling
- **WHEN** trusted Review-N verdict comments repeat without an intervening completed fix transition pair and candidate movement
- **THEN** at most the cycles with proven repair SHALL count toward recurrence, surface streaks, or the round ceiling

#### Scenario: Mixed recurring and new blockers receive a fix round
- **WHEN** at least one current blocker is recurring and at least one is new
- **THEN** the complete blocking set SHALL route to `fix-N`
- **AND** the stage SHALL NOT park or demote the new blocker

#### Scenario: Title rewording at the same location retains identity
- **WHEN** a blocking finding is re-emitted after the proven fix with a reworded title
- **AND** its severity, file, and 5-line location band are unchanged
- **THEN** `findingKey` SHALL return the same key and the finding SHALL count as recurring

#### Scenario: Severity or file/location change creates a new key
- **WHEN** severity, file, or 5-line location band changes
- **THEN** the finding SHALL be treated as new and SHALL retain its normal fix opportunity

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
`reviewCeilingComment` SHALL continue to derive `RECURRING (n rounds)` and `NEW` tags by deterministic
key membership for legacy rendering and operator diagnostics. Those tags and the punch-list text
SHALL NOT themselves establish human authority or control production recurrence; the verified
prior-run production-repair evidence requirement governs disposition.

#### Scenario: Finding present in supplied prior rounds is tagged recurring
- **WHEN** the renderer receives prior Review-N comments containing a finding key
- **THEN** the finding line SHALL include `RECURRING (n rounds)` with the deterministic count

#### Scenario: Finding absent from supplied prior rounds is tagged new
- **WHEN** the renderer receives no prior Review-N comment containing a finding key
- **THEN** the finding line SHALL include `NEW`

#### Scenario: A punch-list cannot grant authority
- **WHEN** a recurrence or ceiling renderer emits a human-oriented punch-list
- **THEN** the controller SHALL still require a current canonical human-decision diagnostic before creating a human hold

