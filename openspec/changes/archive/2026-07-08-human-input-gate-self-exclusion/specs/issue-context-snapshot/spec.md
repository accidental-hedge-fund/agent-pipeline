## MODIFIED Requirements

### Requirement: Pipeline classifies issue comments as human or pipeline-authored
The pipeline SHALL classify every issue comment as either `human` or `pipeline` by comparing the comment body against the known set of pipeline structural markers. A comment SHALL be classified `pipeline` when its leading text begins with any known pipeline comment header — `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review <N>` (for any positive integer N, e.g. `## Review 1`, `## Review 2`, `## Review 3`), `## Pre-merge Delta Review`, `## Fix`, `## Pipeline:`, and `## Pre-Planning Context` — OR when its body contains any pipeline machine-sentinel HTML marker (`<!-- pipeline-audit:`, `<!-- pipeline-override`, `<!-- pipeline-override-scope`, `<!-- pipeline-blocking-keys`, `<!-- pipeline-blocking-surfaces`, `<!-- reviewed-sha`). A comment that matches none of these markers SHALL be classified as `human`. An empty or whitespace-only body SHALL be classified `pipeline`. This classification SHALL be implemented in a single shared utility function (`classifyComment`) used by all downstream consumers. `classifyComment` is a pure body-classification and SHALL NOT change its signature; author-based trust decisions are the responsibility of the gate consumer (see the unacknowledged-input requirement).

#### Scenario: Comment begins with a known pipeline header
- **WHEN** a comment body starts with `## Implementation Plan`
- **THEN** `classifyComment` SHALL return `'pipeline'`
- **AND** the comment SHALL be excluded from the context snapshot

#### Scenario: Comment is a pre-merge delta review verdict
- **WHEN** a comment body starts with `## Pre-merge Delta Review — needs-attention (commit abc1234)`
- **THEN** `classifyComment` SHALL return `'pipeline'`

#### Scenario: Comment is a review round beyond round 2
- **WHEN** a comment body starts with `## Review 3` (or any `## Review <N>` for positive integer N)
- **THEN** `classifyComment` SHALL return `'pipeline'`

#### Scenario: Comment carries a pipeline machine-sentinel marker
- **WHEN** a comment body contains a `<!-- pipeline-audit: run=… state=… -->` sentinel line
- **THEN** `classifyComment` SHALL return `'pipeline'`

#### Scenario: Comment begins with no recognized pipeline header
- **WHEN** a comment body does not start with any of the known pipeline header strings and contains no pipeline machine-sentinel marker
- **THEN** `classifyComment` SHALL return `'human'`
- **AND** the comment SHALL be eligible for inclusion in the context snapshot

#### Scenario: Empty comment body
- **WHEN** a comment body is an empty string or contains only whitespace
- **THEN** `classifyComment` SHALL return `'pipeline'`
- **AND** the comment SHALL be excluded from the context snapshot

---

### Requirement: New human comments posted after the revised plan are detected and surfaced
After the revised plan is posted (the `## Revised Implementation Plan` comment), the pipeline SHALL detect any comment posted after the plan anchor that is unacknowledged human input, and before the next stage boundary (review or next fix round) SHALL post a single `## Pipeline: New human input detected` warning comment listing those comments and noting that a re-plan or explicit acknowledgement is required. Unacknowledged comments SHALL NOT be injected into implementation, review, or fix-round prompts.

A comment posted after the plan anchor SHALL be counted as **unacknowledged human input** UNLESS one of the following holds:

1. **Pipeline self-output (author-gated):** the comment is classified `pipeline` by `classifyComment` AND its author is the authenticated pipeline actor (`getGhActor`) or an entry in `cfg.trusted_override_actors`. A comment classified `pipeline` whose author is **not** a trusted actor SHALL still be counted as human input — a forged pipeline-styled heading from a third party does not grant self-exclusion, preserving the gate's forge resistance.
2. **At or before an acknowledgement anchor:** the comment is at or before the effective acknowledgement anchor. The anchor is the latest of: the plan comment, a trusted-actor `## Pipeline: Scope override` comment posted after the plan, and — new in this change — a **plain acknowledgement**: a comment authored by a trusted actor (pipeline actor or a `trusted_override_actors` entry) that contains no scope-changing / change-request language. Such a plain acknowledgement SHALL advance the anchor (dismissing prior unacknowledged human comments) and SHALL NOT itself be counted.

Because the pipeline posts under the operator's own `gh` identity in single-operator repos, self-exclusion SHALL rely on the comment's structural markers (rule 1) rather than on a distinct bot login; the author check only distinguishes the trusted actor from third parties.

#### Scenario: No new comments after the revised plan
- **WHEN** no comments are posted after the revised-plan comment
- **THEN** the pipeline SHALL NOT post a `## Pipeline: New human input detected` comment
- **AND** implementation and review proceed normally

#### Scenario: Pipeline's own delta-review comments do not gate against itself
- **WHEN** the only comments posted after the plan anchor are the pipeline's own `## Pre-merge Delta Review — needs-attention` verdict and its follow-up `## Pre-merge Delta Review — approve`, both authored by the pipeline actor's login
- **THEN** the unacknowledged-human-input count SHALL be zero
- **AND** the pipeline SHALL NOT post a `## Pipeline: New human input detected` comment and SHALL NOT block the stage boundary

#### Scenario: Forged pipeline-styled comment from a non-trusted author is still counted
- **WHEN** a comment authored by someone who is neither the pipeline actor nor a `trusted_override_actors` entry is posted after the plan anchor
- **AND** its body mimics a pipeline heading (e.g. begins with `## Pre-merge Delta Review — approve`)
- **THEN** that comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL block the stage boundary and post the `## Pipeline: New human input detected` warning

#### Scenario: Plain trusted-actor acknowledgement clears the gate without a scope-override heading
- **WHEN** a genuine human comment from a trusted actor is posted after the plan anchor and remains unacknowledged
- **AND** the trusted actor then posts a later comment containing no scope-changing / change-request language (no `## Pipeline: Scope override` heading required)
- **THEN** the later comment SHALL act as an acknowledgement anchor and the earlier comment SHALL no longer be counted as unacknowledged
- **AND** the plain-acknowledgement comment SHALL NOT itself be counted as a new unacknowledged item on the next resume

#### Scenario: Trusted-actor comment with scope-changing language still gates
- **WHEN** a comment authored by a trusted actor is posted after the plan anchor and contains change-request / scope-changing language (e.g. "don't", "instead", "revert", "wrong approach")
- **THEN** that comment SHALL NOT act as an acknowledgement anchor
- **AND** it SHALL be counted as unacknowledged human input exactly as today

#### Scenario: Multiple unacknowledged comments are batched into one warning
- **WHEN** three unacknowledged human comments are posted after the revised plan before the pipeline reaches the next stage boundary
- **THEN** the pipeline SHALL post exactly one `## Pipeline: New human input detected` comment listing all three comments
- **AND** the pipeline SHALL NOT post one warning per comment
