# review-artifact-record Specification

## Purpose
TBD - created by archiving change migrate-review-comments-to-structured-artifact. Update Purpose after archive.

## Requirements

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

### Requirement: New review artifacts SHALL carry a nested evidence_subject

When the pipeline posts a new review comment (round 1, round 2, or delta re-review) and embeds a `ReviewArtifact` block, the artifact JSON SHALL include a nested `evidence_subject` conforming to the shared `evidence-subject` contract (`schema_version` starting at `1`). The subject SHALL be built by deterministic engine code from the runtime evaluation pin at review time (domain, issue, PR, run id when known, reviewed candidate SHA, canonical diff hash, effective review policy hash, engine and verifier/prompt fingerprints, required-evidence-set revision). Existing fields `reviewedSha` and `diffHash` SHALL remain for backward compatibility and SHALL equal `evidence_subject.candidate_sha` and `evidence_subject.diff_hash` respectively when the subject is present (`diffHash` / `diff_hash` both null when the diff is unavailable under existing rules). Model-authored review body text SHALL NOT supply subject fields.

#### Scenario: new review artifact includes evidence_subject

- **WHEN** the pipeline posts a review comment for any review round with a `ReviewArtifact` block
- **THEN** decoding the artifact SHALL yield an `evidence_subject` object with `schema_version: 1`
- **AND** `evidence_subject.candidate_sha` SHALL equal `reviewedSha`
- **AND** when a PR diff was available, `evidence_subject.diff_hash` SHALL equal `diffHash`

#### Scenario: subject is engine-authored not reviewer prose

- **WHEN** the reviewer model outputs free text that claims a different commit SHA
- **THEN** the footer `ReviewArtifact.evidence_subject` SHALL still use the engine-resolved reviewed HEAD SHA
- **AND** SHALL NOT copy the free-text claim into the subject

#### Scenario: legacy comments without subject remain extractable

- **WHEN** a gate reads a pre-migration review comment whose `ReviewArtifact` lacks `evidence_subject` or that has only individual sentinels
- **THEN** `extractReviewArtifact` behavior for existing fields SHALL remain available
- **AND** subject comparison SHALL classify the artifact as `legacy_unbound` when no subject is present

---

### Requirement: Gates that compose multi-family readiness SHALL prefer evidence_subject comparison

When a gate or readiness consumer needs multi-dimension identity (not only SHA or only diff hash), it SHALL read `evidence_subject` from the review artifact when present and apply the shared comparison semantics against the evaluation pin. Field-level fallbacks (`reviewedSha`, `diffHash`, individual sentinels) remain valid for family-local SHA and diff-hash checks and for `legacy_unbound` artifacts. A subject `mismatch` on candidate or diff SHALL NOT be treated as a full multi-family readiness match even if a single legacy sentinel happens to equal one pin field.

#### Scenario: subject mismatch blocks treating review as co-current with other evidence

- **WHEN** a readiness consumer compares a review artifact subject to the evaluation pin
- **AND** comparison returns `mismatch` on `candidate_sha` or `diff_hash`
- **THEN** the consumer SHALL treat that review evidence as non-current for multi-family readiness composition
- **AND** SHALL NOT claim subject match solely because a short SHA in comment prose matches

#### Scenario: matching subject allows existing verdict routing rules

- **WHEN** a review artifact’s `evidence_subject` matches the evaluation pin
- **THEN** existing SHA-gate, diff-hash cache, and blocking-keys rules MAY apply as today for that review
- **AND** residual blocking keys on a matched subject still hold under existing review-sha-gating rules

### Requirement: Posted review and delta bodies SHALL verify after engine-owned banner inserts

When the pipeline posts a review-1, review-2, or pre-merge delta comment, it SHALL bind `ReviewArtifact.bodyHash` to the exact posted prefix after every engine-owned mutation of that prefix. Engine-owned mutations include the reviewer-coverage disclosure line (`**Reviewer coverage (#694):** …`), the ensemble identity line, and same-harness self-review warning lines. After the last such mutation and before post, a freshly computed hash of the text preceding the last `<!-- review-artifact: … -->` line SHALL equal the recorded `bodyHash`. The pipeline SHALL NOT mutate that hashed region after `bodyHash` is written.

`isVerifiedPipelineReviewOutput` (and therefore `isVerifiedPipelineOutput`) SHALL return true for that posted body. New posts SHALL satisfy this on the exact prefix. They SHALL NOT depend on a read-side banner strip.

This requirement does not remove coverage disclosure. The banner remains part of the attested body.

#### Scenario: Coverage-wrapped review-1 comment verifies

- **WHEN** the pipeline renders a review-1 comment and the production post wrapper inserts a `**Reviewer coverage (#694):**` line after the heading
- **THEN** the posted body SHALL carry a `<!-- review-artifact: … -->` record
- **AND** `isVerifiedPipelineReviewOutput` SHALL return true for that posted body
- **AND** `isVerifiedPipelineOutput` SHALL return true for that posted body

#### Scenario: Coverage-wrapped review-2 comment verifies

- **WHEN** the pipeline renders a review-2 comment and the production post wrapper inserts a coverage banner (and any ensemble or self-review banner that wrapper emits for that round)
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true for the posted body
- **AND** a freshly computed hash of the exact text preceding the last review-artifact line SHALL equal the recorded `bodyHash`

#### Scenario: Coverage-wrapped delta comment verifies

- **WHEN** the pipeline renders a pre-merge delta review comment and the production post wrapper inserts the same class of engine-owned banners
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true for the posted body

#### Scenario: Hash is bound after the last engine-owned insert

- **WHEN** the production post wrapper applies one or more engine-owned banner lines to a freshly rendered review or delta body
- **THEN** it SHALL bind `bodyHash` after those inserts and before the GitHub post
- **AND** it SHALL NOT post a body whose hashed prefix was mutated after `bodyHash` was written

#### Scenario: Human text in the review prefix still fails verification

- **WHEN** a review body has a human objection line (for example `Do not merge this — do X instead.`) between the heading and `**Reviewer**:` that is not an engine-owned banner line
- **AND** the stored `bodyHash` was computed without that objection
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return false

#### Scenario: Shared finalize path rebinds the last artifact after all banners

- **WHEN** review-1, review-2, or either pre-merge delta post path inserts one or more engine-owned banners
- **THEN** that path SHALL call one shared `finalizeReviewArtifactComment` (insert banners, then rebind)
- **AND** the rebind SHALL rewrite only the last `<!-- review-artifact: … -->` line
- **AND** the rebind SHALL set `bodyHash` to `hashReviewBody` of the exact preceding prefix (one trailing newline stripped when present)
- **AND** every other artifact field SHALL be unchanged
- **AND** if any non-whitespace follows the last artifact line, the function SHALL leave the body unchanged

#### Scenario: Exact-prefix hash matches on a newly finalized body

- **WHEN** a review or delta body is assembled with one or more engine-owned banners through `finalizeReviewArtifactComment`
- **THEN** `hashReviewBody` of the exact text preceding the last review-artifact line SHALL equal the recorded `bodyHash`
- **AND** `isVerifiedPipelineReviewOutput` SHALL return true without using the compatibility strip

---

### Requirement: Already-posted review bodies MAY verify by stripping only engine-owned banners

For a review or delta comment whose stored `bodyHash` was computed before an engine-owned banner insert (comments posted under v1.39.1 and earlier), `isVerifiedPipelineReviewOutput` MAY strip only the documented engine-owned banner lines that sit between the review heading and `**Reviewer**:`, then retry the hash comparison. Removable lines are only the four complete formatter-produced forms: the `formatCoverageDisclosure` coverage line (closed `AggregationOutcome` token, optional degraded suffix only for `same_lineage_fallback` / `quorum_unmet`, optional parenthesized reason only when it matches a `classifyAggregationOutcome` machine-readable form), the `formatEnsembleIdentityLine` line (`merge=union_blocking`, optional closed coverage clause, closed agent-list grammar), the complete `ensembleSelfReviewBanner` sentence, and the complete `selfReviewBanner` sentence. Each recognizer SHALL be end-anchored. The strip SHALL NOT remove a line that only begins with a production prefix and then continues with other text. The strip SHALL NOT remove, reorder, or drop any other line in that window. The strip SHALL NOT remove human-authored lines, including markdown that only resembles a banner. When the stripped prefix hashes to the recorded `bodyHash` and nothing follows the artifact line, verification SHALL succeed.

New posts SHALL NOT rely on this path. A body that needs the strip only because a new insert was not rebound SHALL be treated as a contract defect in the post path.

#### Scenario: Already-posted coverage banner still verifies

- **WHEN** a stored review-2 body has a `**Reviewer coverage (#694):**` line inserted after the heading
- **AND** the recorded `bodyHash` matches the prefix with that banner removed and does not match the exact prefix
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return true

#### Scenario: Compatibility strip does not accept a human objection

- **WHEN** a stored review body has a human objection line between the heading and `**Reviewer**:` and no engine-owned banner
- **AND** the recorded `bodyHash` matches the prefix without that objection
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return false

#### Scenario: Compatibility strip does not accept a human line among valid banners

- **WHEN** a stored review body has allowlisted engine-owned banner lines between the heading and `**Reviewer**:`
- **AND** a human line sits among those banners (including a line that starts with `**Reviewer coverage (#694):**` or `**Ensemble** (` but does not match a production form, or `> ⚠️ **Please do not merge this instead.**`)
- **AND** the recorded `bodyHash` matches the prefix with only production banners removed
- **THEN** `isVerifiedPipelineReviewOutput` SHALL return false

#### Scenario: Compatibility strip does not accept a production prefix with appended human text

- **WHEN** a stored review body has a line between the heading and `**Reviewer**:` that begins with a production coverage, ensemble-identity, ensemble-self-review, or self-review banner prefix
- **AND** that line continues with human objection text (for example ` (do not merge; use X instead)` or ` Do not merge this — do X instead.`)
- **AND** the recorded `bodyHash` matches the prefix with that line removed
- **THEN** the strip SHALL leave the line in place
- **AND** `isVerifiedPipelineReviewOutput` SHALL return false
