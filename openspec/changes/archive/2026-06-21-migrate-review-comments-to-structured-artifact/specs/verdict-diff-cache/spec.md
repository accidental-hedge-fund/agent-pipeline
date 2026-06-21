## MODIFIED Requirements

### Requirement: Review comments SHALL embed a diff-hash sentinel keyed to the reviewed diff

When the pipeline posts a review comment for any review round, the comment SHALL include the diff hash both as the individual HTML-comment sentinel `<!-- verdict-diff-hash: <hash> -->` on its own line (for backward compatibility) and inside the `ReviewArtifact` block (`diffHash` field) described in `review-artifact-record`. The hash SHALL remain the first 16 hexadecimal characters of the SHA-256 digest of the raw PR diff string. When the diff is unavailable (e.g., in tests that do not supply one), `diffHash` SHALL be `null` in the artifact and the individual sentinel SHALL be omitted, matching prior behavior.

#### Scenario: Review comment includes diff-hash sentinel

- **WHEN** the pipeline posts a review comment for round N
- **THEN** the comment body SHALL contain the line `<!-- verdict-diff-hash: <hash> -->` where `<hash>` is the 16-character hex prefix of the SHA-256 of the PR diff evaluated in that review
- **AND** the sentinel SHALL appear for both `approve` and `needs-attention` verdicts

#### Scenario: Review comment includes diff-hash in the ReviewArtifact block

- **WHEN** the pipeline posts a review comment for round N and a PR diff was available
- **THEN** the `ReviewArtifact` block SHALL carry `diffHash` equal to the same 16-character hex string
- **AND** `artifact.diffHash` SHALL equal the value in the `<!-- verdict-diff-hash: … -->` sentinel

#### Scenario: Diff-hash sentinel reflects the exact diff passed to the reviewer

- **WHEN** `advanceReview` fetches the PR diff and invokes the reviewer
- **THEN** the `verdict-diff-hash` sentinel AND `artifact.diffHash` in the posted comment SHALL be derived from the identical diff string that was provided to the reviewer — not a subsequent fetch

---

### Requirement: Re-entering a review stage on an unchanged diff SHALL return the cached verdict without invoking the reviewer

Before invoking the reviewer in a review stage, the pipeline SHALL compute the current PR diff hash and compare it to the diff hash from the most recent prior review comment for the same round. The diff hash SHALL be read via `extractReviewArtifact(body)?.diffHash` first; when `extractReviewArtifact` returns `null` or `diffHash` is `null`, the pipeline SHALL fall back to the `<!-- verdict-diff-hash: … -->` individual sentinel extractor. If the hashes match, the pipeline SHALL return the cached verdict routing result without calling the reviewer and SHALL log a notice that the cached verdict is being reused.

#### Scenario: Cache hit — unchanged diff returns cached verdict

- **WHEN** the pipeline enters review stage N
- **AND** the most recent review-N comment carries a matching diff hash (via artifact or fallback sentinel) equal to the current PR diff hash
- **THEN** the pipeline SHALL NOT invoke the reviewer
- **AND** SHALL route the issue based on the cached verdict (approve advances; needs-attention routes to fix or advances under policy)
- **AND** SHALL log a notice of the form "Diff hash unchanged; reusing cached verdict for round N"

#### Scenario: Cache miss — changed diff invokes the reviewer

- **WHEN** the pipeline enters review stage N
- **AND** the most recent review-N comment carries no diff hash, or the diff hash does not match the current PR diff hash
- **THEN** the pipeline SHALL invoke the reviewer normally
- **AND** the posted review comment SHALL embed the new diff hash in both the individual sentinel and the artifact block

#### Scenario: No prior review comment — normal first-run review

- **WHEN** the pipeline enters review stage N and no prior review-N comment exists
- **THEN** the pipeline SHALL run the review normally (no cache check needed)
- **AND** the posted comment SHALL include the `verdict-diff-hash` sentinel and the `diffHash` field in the artifact block

#### Scenario: Malformed or unextractable diff-hash — treated as cache miss

- **WHEN** the most recent review-N comment contains no artifact block and no well-formed `verdict-diff-hash` sentinel
- **THEN** the pipeline SHALL treat it as a cache miss and invoke the reviewer normally

#### Scenario: Legacy comment — diff hash read from individual sentinel

- **WHEN** the diff-hash cache reads a pre-migration review comment that carries no `ReviewArtifact` block
- **THEN** `extractReviewArtifact` SHALL return `null`
- **AND** the pipeline SHALL extract the diff hash from the `<!-- verdict-diff-hash: … -->` sentinel
- **AND** cache behaviour SHALL be identical to the pre-migration path

---

### Requirement: Diff-hash sentinel extraction SHALL use last-occurrence-wins semantics

`extractDiffHashFromComment(body: string): string | null` SHALL extract the `verdict-diff-hash` sentinel using a full-line-anchored regex and SHALL return the value from the LAST matching line in the comment body. When no matching line is present, it SHALL return `null`. This extractor is retained as the legacy fallback path; the primary path is `extractReviewArtifact(body)?.diffHash`.

#### Scenario: Sentinel present — correct hash returned

- **WHEN** a comment body contains one or more `<!-- verdict-diff-hash: … -->` lines
- **THEN** `extractDiffHashFromComment` SHALL return the hash from the last such line

#### Scenario: No sentinel present — returns null

- **WHEN** a comment body contains no `<!-- verdict-diff-hash: … -->` line
- **THEN** `extractDiffHashFromComment` SHALL return `null`
