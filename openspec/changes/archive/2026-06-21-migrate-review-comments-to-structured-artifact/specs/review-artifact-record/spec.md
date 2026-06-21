## ADDED Requirements

### Requirement: Every new review comment SHALL embed a ReviewArtifact JSON block

When the pipeline posts any review comment (round 1, round 2, or delta re-review), it SHALL append a single hidden `ReviewArtifact` block to the comment footer after the existing individual sentinels. The block SHALL be encoded as: `<!-- review-artifact: <base64url(JSON)> -->` on its own line, where the JSON conforms to the `ReviewArtifact` struct. The struct SHALL carry: `round` (1 or 2), `reviewedSha` (40-character commit SHA), `diffHash` (16-char hex SHA-256 prefix of the reviewed diff, or `null` when not available), `blockingKeys` (sorted deduplicated array of blocking finding keys), and `review1Risk` (`"low"` | `"standard"` | `null`; `null` when the round-1 risk tier is not yet determined). No additional top-level fields are required; the implementation MAY add optional extension fields without breaking readers that ignore unknown fields.

#### Scenario: new review comment contains the artifact block

- **WHEN** the pipeline posts a review comment for round 1 or round 2
- **THEN** the comment body SHALL contain exactly one `<!-- review-artifact: … -->` line in the footer
- **AND** decoding the base64 payload SHALL yield a valid JSON object with `round`, `reviewedSha`, `diffHash`, `blockingKeys`, and `review1Risk` fields

#### Scenario: artifact block appears after existing sentinels

- **WHEN** a review comment is posted
- **THEN** the `<!-- review-artifact: … -->` line SHALL appear after the `<!-- reviewed-sha: … -->`, `<!-- verdict-diff-hash: … -->`, `<!-- pipeline-blocking-keys: … -->`, and `<!-- pipeline-review1-risk: … -->` sentinels
- **AND** the pipeline SHALL continue to write all four individual sentinels for backward compatibility

#### Scenario: blockingKeys reflects the verdict partition

- **WHEN** a review produces N blocking findings
- **THEN** the `blockingKeys` field in the artifact SHALL contain exactly the N keys from the blocking partition, sorted and deduplicated
- **AND** the `blockingKeys` sentinel embedded in the same comment SHALL carry the same set

#### Scenario: approve verdict produces an empty blockingKeys array

- **WHEN** a review round returns `approve` with zero blocking findings
- **THEN** the `blockingKeys` field in the artifact SHALL be an empty array `[]`

---

### Requirement: The pipeline SHALL read gate fields from the ReviewArtifact as the primary path

When any gate (SHA gate, diff-hash cache, blocking-keys check, risk-tier lookup) reads state from a review comment, it SHALL call `extractReviewArtifact(body)` first. When the function returns a non-null artifact, the gate SHALL use the corresponding field from the struct. When `extractReviewArtifact` returns `null` (no artifact block present), the gate SHALL fall back to the appropriate individual sentinel extractor. Each field SHALL fall back independently so a partial-artifact or future-format artifact degrades gracefully.

#### Scenario: artifact present — gate uses struct field

- **WHEN** a gate reads the `reviewedSha` for SHA comparison
- **AND** `extractReviewArtifact` returns a non-null artifact for that comment
- **THEN** the gate SHALL use `artifact.reviewedSha` and SHALL NOT call `extractVerdictSha` for that comment

#### Scenario: no artifact present — gate falls back to legacy sentinel

- **WHEN** a gate reads the `reviewedSha` for SHA comparison
- **AND** `extractReviewArtifact` returns `null` for that comment (old comment, no block)
- **THEN** the gate SHALL call `extractVerdictSha(body)` as the fallback
- **AND** the gate behaviour SHALL be identical to the pre-migration path

#### Scenario: malformed artifact block — treated as absent

- **WHEN** a comment contains a `<!-- review-artifact: … -->` line whose payload is not valid base64 or does not decode to a conforming JSON object
- **THEN** `extractReviewArtifact` SHALL return `null`
- **AND** the gate SHALL fall back to individual sentinel extractors

---

### Requirement: Extraction SHALL use last-occurrence-wins semantics for injection resistance

`extractReviewArtifact(body: string): ReviewArtifact | null` SHALL locate all `<!-- review-artifact: … -->` lines in the comment body and return the decoded value of the LAST such line. When no such line is present it SHALL return `null`. It SHALL never return the value of any earlier occurrence, because reviewer-authored content appearing before the footer could contain an adversarially crafted block.

#### Scenario: single artifact block — returned

- **WHEN** a comment body contains exactly one `<!-- review-artifact: … -->` line
- **THEN** `extractReviewArtifact` SHALL return the decoded artifact from that line

#### Scenario: injected block before legitimate footer block — last wins

- **WHEN** a comment body contains a `<!-- review-artifact: … -->` line in the reviewer-authored section followed by a legitimate block in the pipeline footer
- **THEN** `extractReviewArtifact` SHALL return the decoded artifact from the footer (last occurrence) only
- **AND** the injected block SHALL have no effect on gate reads

#### Scenario: no artifact block — returns null

- **WHEN** a comment body contains no `<!-- review-artifact: … -->` line
- **THEN** `extractReviewArtifact` SHALL return `null`
