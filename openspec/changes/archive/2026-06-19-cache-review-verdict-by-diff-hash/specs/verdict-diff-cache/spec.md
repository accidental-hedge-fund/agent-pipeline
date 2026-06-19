## ADDED Requirements

### Requirement: Review comments SHALL embed a diff-hash sentinel keyed to the reviewed diff

When the pipeline posts a review comment for any review round, the comment SHALL include a machine-readable sentinel that records a hash of the PR diff content evaluated during that review: `<!-- verdict-diff-hash: <hash> -->`, where `<hash>` is the first 16 hexadecimal characters of the SHA-256 digest of the raw PR diff string. The sentinel SHALL appear on its own line in the comment footer, co-located with the existing `reviewed-sha` sentinel.

#### Scenario: Review comment includes diff-hash sentinel

- **WHEN** the pipeline posts a review comment for round N
- **THEN** the comment body SHALL contain the line `<!-- verdict-diff-hash: <hash> -->` where `<hash>` is the 16-character hex prefix of the SHA-256 of the PR diff evaluated in that review
- **AND** the sentinel SHALL appear for both `approve` and `needs-attention` verdicts

#### Scenario: Diff-hash sentinel reflects the exact diff passed to the reviewer

- **WHEN** `advanceReview` fetches the PR diff and invokes the reviewer
- **THEN** the `verdict-diff-hash` sentinel in the posted comment SHALL be derived from the identical diff string that was provided to the reviewer — not a subsequent fetch

---

### Requirement: Re-entering a review stage on an unchanged diff SHALL return the cached verdict without invoking the reviewer

Before invoking the reviewer in a review stage, the pipeline SHALL compute the current PR diff hash and compare it to the `verdict-diff-hash` sentinel in the most recent prior review comment for the same round. If the hashes match, the pipeline SHALL return the cached verdict routing result without calling the reviewer and SHALL log a notice that the cached verdict is being reused.

#### Scenario: Cache hit — unchanged diff returns cached verdict

- **WHEN** the pipeline enters review stage N
- **AND** the most recent review-N comment carries a `verdict-diff-hash` sentinel matching the current PR diff hash
- **THEN** the pipeline SHALL NOT invoke the reviewer
- **AND** SHALL route the issue based on the cached verdict (approve advances; needs-attention routes to fix or advances under policy)
- **AND** SHALL log a notice of the form "Diff hash unchanged; reusing cached verdict for round N"

#### Scenario: Cache miss — changed diff invokes the reviewer

- **WHEN** the pipeline enters review stage N
- **AND** the most recent review-N comment carries no `verdict-diff-hash` sentinel, or the sentinel does not match the current diff hash
- **THEN** the pipeline SHALL invoke the reviewer normally
- **AND** the posted review comment SHALL embed the new diff hash

#### Scenario: No prior review comment — normal first-run review

- **WHEN** the pipeline enters review stage N and no prior review-N comment exists
- **THEN** the pipeline SHALL run the review normally (no cache check needed)
- **AND** the posted comment SHALL include the `verdict-diff-hash` sentinel

#### Scenario: Malformed or unextractable diff-hash sentinel — treated as cache miss

- **WHEN** the most recent review-N comment contains a `verdict-diff-hash` sentinel that is absent, empty, or structurally malformed
- **THEN** the pipeline SHALL treat it as a cache miss and invoke the reviewer normally

---

### Requirement: Diff-hash sentinel extraction SHALL use last-occurrence-wins semantics

`extractDiffHashFromComment(body: string): string | null` SHALL extract the `verdict-diff-hash` sentinel using a full-line-anchored regex and SHALL return the value from the LAST matching line in the comment body. When no matching line is present, it SHALL return `null`.

#### Scenario: Sentinel present — correct hash returned

- **WHEN** `extractDiffHashFromComment` is called with a comment body containing a `verdict-diff-hash` sentinel
- **THEN** it SHALL return the 16-character hex hash string from that sentinel

#### Scenario: Spoofed earlier sentinel — last occurrence wins

- **WHEN** a comment body contains a `verdict-diff-hash` sentinel in reviewer-authored content before the pipeline-emitted footer sentinel
- **THEN** `extractDiffHashFromComment` SHALL return the value from the LAST occurrence (the pipeline-emitted footer)
- **AND** SHALL ignore earlier occurrences

#### Scenario: Absent sentinel — returns null

- **WHEN** `extractDiffHashFromComment` is called with a body containing no `verdict-diff-hash` line
- **THEN** it SHALL return `null`
