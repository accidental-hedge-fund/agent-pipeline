## MODIFIED Requirements

### Requirement: Pipeline classifies issue comments as human or pipeline-authored
The pipeline SHALL classify every issue comment as either `human` or `pipeline` by comparing the comment body against the known set of pipeline structural markers. A comment SHALL be classified `pipeline` when its leading text begins with any known pipeline comment header — `## Implementation Plan`, `## Plan Review`, `## Revised Implementation Plan`, `## Review <N>` (for any positive integer N, e.g. `## Review 1`, `## Review 2`, `## Review 3`), `## Pre-merge Delta Review`, `## Fix`, `## Pipeline:`, `## Pre-Planning Context`, and `## Design Interrogation` — OR when its body contains any pipeline machine-sentinel HTML marker (`<!-- pipeline-audit:`, `<!-- pipeline-override`, `<!-- pipeline-override-scope`, `<!-- pipeline-blocking-keys`, `<!-- pipeline-blocking-surfaces`, `<!-- reviewed-sha`, `<!-- pipeline-attest:`). A comment that matches none of these markers SHALL be classified as `human`. An empty or whitespace-only body SHALL be classified `pipeline`. This classification SHALL be implemented in a single shared utility function (`classifyComment`) used by all downstream consumers. `classifyComment` is a pure body-classification and SHALL NOT change its signature; author-based trust decisions are the responsibility of the gate consumer (see the unacknowledged-input requirement).

`## Design Interrogation` is a #390-class inventory extension for the design-gate stage (#436 / #872): design-gate progress comments MUST classify as `pipeline` so they are eligible for trusted self-exclusion under the human-input gate and are excluded from the pre-planning human-comment snapshot.

#### Scenario: Comment begins with a known pipeline header
- **WHEN** a comment body starts with `## Implementation Plan`
- **THEN** `classifyComment` SHALL return `'pipeline'`
- **AND** the comment SHALL be excluded from the context snapshot

#### Scenario: Comment is a design-gate Design Interrogation progress post
- **WHEN** a comment body starts with `## Design Interrogation`
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

#### Scenario: Comment carries a pipeline-attest marker
- **WHEN** a comment body contains a `<!-- pipeline-attest: … -->` sentinel line
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

1. **Pipeline self-output (author-gated):** the comment is classified `pipeline` by `classifyComment` AND its author is the authenticated pipeline actor (`getGhActor`) or an entry in `cfg.trusted_override_actors`, AND either (a) the body is **verified pipeline output** per `isVerifiedPipelineOutput` — that is, it carries a `review-artifact` or pipeline attestation whose `bodyHash` matches the rendered body, **or** a terminal, decodable design-gate durable-state artifact (`<!-- design-gate-state: … -->`) on a design-interrogation-shaped body accepted by the design-gate verification predicate (#436 / #872 recovery for pre-attestation posts) — or (b) the body carries no scope-changing / change-request language of its own. A comment classified `pipeline` whose author is **not** a trusted actor SHALL still be counted as human input — a forged pipeline-styled heading or a copied attestation from a third party does not grant self-exclusion, preserving the gate's forge resistance. A trusted actor's comment that merely mimics pipeline structure while carrying a genuine objection SHALL also still be counted.
2. **At or before an acknowledgement anchor:** the comment is at or before the effective acknowledgement anchor. The anchor is the latest of: the plan comment, a trusted-actor `## Pipeline: Scope override` comment posted after the plan, and a **plain acknowledgement**: a comment authored by a trusted actor (pipeline actor or a `trusted_override_actors` entry) that is classified `human` and contains no scope-changing / change-request language. Such a plain acknowledgement SHALL advance the anchor (dismissing prior unacknowledged human comments) and SHALL NOT itself be counted.

The verified-output exemption in rule 1(a) exists because the pipeline's own generated bodies routinely use objection wording — review findings quote defects, design-gate challenge titles recommend revisions, and transition comments explain why an item advanced *instead* of routing to a fix round. It SHALL apply to **any** attested comment type and to terminal decodable design-gate durable-state artifacts, not only review verdicts. It SHALL NOT be widened into a general unverified trust path: a historical pipeline comment carrying no verification artifact and objection wording gates once, and a plain trusted-actor acknowledgement clears it permanently via rule 2. Non-decodable or non-terminal design-gate-shaped bodies SHALL fail closed.

Because the pipeline posts under the operator's own `gh` identity in single-operator repos, self-exclusion SHALL rely on the comment's structural markers and attestation (rule 1) rather than on a distinct bot login; the author check only distinguishes the trusted actor from third parties.

#### Scenario: Severity-policy transition comment does not gate the next review stage
- **WHEN** review 1 produces findings that none meet the active `review_policy.block_threshold`
- **AND** the pipeline posts `## Pipeline: Review 1 advanced under severity policy` under the pipeline actor's login after the plan anchor
- **THEN** `findUnacknowledgedComments` SHALL return zero unacknowledged comments
- **AND** review-2 routing SHALL NOT post `## Pipeline: New human input detected` and SHALL NOT block the stage boundary

#### Scenario: Design-gate Design Interrogation comments do not gate review-1 (#872)
- **WHEN** the only comments posted after the plan anchor are trusted-actor design-gate progress comments whose bodies start with `## Design Interrogation` and verify as pipeline output (via `pipeline-attest` and/or a terminal decodable `design-gate-state` artifact)
- **AND** those bodies contain challenge prose matching objection patterns (e.g. "do not", "instead")
- **THEN** `findUnacknowledgedComments` SHALL return zero unacknowledged comments
- **AND** review-1 / fix entry SHALL NOT post `## Pipeline: New human input detected` and SHALL NOT set `pipeline:blocked` solely because of those design-gate comments

#### Scenario: Attested pipeline comment with objection wording is exempt from the objection scan
- **WHEN** a trusted-actor comment is verified pipeline output per `isVerifiedPipelineOutput`
- **AND** its body contains wording matching the objection patterns (e.g. "instead", "revert")
- **THEN** it SHALL NOT be counted as unacknowledged human input

#### Scenario: Terminal decodable design-gate-state without pipeline-attest does not gate (#784 / #872 recovery)
- **WHEN** a trusted-actor comment after the plan anchor starts with `## Design Interrogation`, ends on a terminal decodable `<!-- design-gate-state: … -->` marker with no trailing content, and carries no `pipeline-attest` marker
- **AND** its body contains objection-pattern wording
- **THEN** `isVerifiedPipelineOutput` SHALL return true for that body
- **AND** `findUnacknowledgedComments` SHALL NOT count the comment as unacknowledged human input

#### Scenario: Attested body from a non-trusted author is still counted
- **WHEN** a comment carrying a valid pipeline attestation is posted after the plan anchor by an author who is neither the pipeline actor nor a `trusted_override_actors` entry
- **THEN** that comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL block the stage boundary and post the `## Pipeline: New human input detected` warning

#### Scenario: Non-decodable design-gate-shaped body with objection wording still gates
- **WHEN** a trusted-actor comment after the plan anchor starts with `## Design Interrogation` and carries a non-decodable `design-gate-state` payload (and no valid `pipeline-attest`)
- **AND** its body contains objection-pattern wording
- **THEN** the comment SHALL be counted as unacknowledged human input

#### Scenario: Human text appended to an attested pipeline comment still gates
- **WHEN** a trusted actor posts a body consisting of an attested pipeline comment with additional human objection text appended after the attestation line
- **THEN** verification SHALL fail, the objection scan SHALL apply
- **AND** the comment SHALL be counted as unacknowledged human input

#### Scenario: Human text after a terminal design-gate-state marker still gates
- **WHEN** a trusted actor posts a design-interrogation body whose `design-gate-state` marker is followed by additional human objection text
- **THEN** design-gate verification SHALL fail
- **AND** the comment SHALL be counted as unacknowledged human input when objection-pattern wording is present

#### Scenario: Genuine human comment after plan remains unacknowledged
- **WHEN** a free-form human comment with no pipeline structural markers is posted after the plan anchor by any author
- **THEN** that comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL block the stage boundary until re-plan or a trusted acknowledgement / override path clears it

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
- **AND** its body mimics a pipeline heading (e.g. begins with `## Pre-merge Delta Review — approve` or `## Design Interrogation`)
- **THEN** that comment SHALL be counted as unacknowledged human input
- **AND** the pipeline SHALL block the stage boundary and post the `## Pipeline: New human input detected` warning

#### Scenario: Plain trusted-actor acknowledgement clears the gate without a scope-override heading
- **WHEN** a genuine human comment from a trusted actor is posted after the plan anchor and remains unacknowledged
- **AND** the trusted actor then posts a later comment containing no scope-changing / change-request language (no `## Pipeline: Scope override` heading required)
- **THEN** the later comment SHALL act as an acknowledgement anchor and the earlier comment SHALL no longer be counted as unacknowledged
- **AND** the plain-acknowledgement comment SHALL NOT itself be counted as a new unacknowledged item on the next resume

#### Scenario: Trusted-actor comment with scope-changing language still gates
- **WHEN** a comment authored by a trusted actor is posted after the plan anchor and contains change-request / scope-changing language (e.g. "don't", "instead", "revert", "wrong approach")
- **AND** the comment is not verified pipeline output
- **THEN** that comment SHALL NOT act as an acknowledgement anchor
- **AND** it SHALL be counted as unacknowledged human input exactly as today

#### Scenario: Multiple unacknowledged comments are batched into one warning
- **WHEN** three unacknowledged human comments are posted after the revised plan before the pipeline reaches the next stage boundary
- **THEN** the pipeline SHALL post exactly one `## Pipeline: New human input detected` comment listing all three comments
- **AND** the pipeline SHALL NOT post one warning per comment

---

### Requirement: Every pipeline-posted comment carries a verifiable output attestation
The pipeline SHALL enumerate every comment type it posts to an issue or PR in a single exported registry, and every comment it posts SHALL carry a verification artifact that binds the exact rendered body: either the existing `<!-- review-artifact: … -->` record whose `bodyHash` matches the text preceding it, or a generic pipeline attestation marker (`<!-- pipeline-attest: <base64url payload> -->`) whose payload carries the comment kind and a `bodyHash` over the text preceding the marker line. A single verifier (`isVerifiedPipelineOutput`) SHALL return true for a body carrying either verified form and false otherwise, **and** SHALL also return true for a design-interrogation body whose durable `<!-- design-gate-state: … -->` artifact is present, decodable, and terminal (nothing non-empty after the last marker line) — the #436 / #872 recovery path for pre-attestation design-gate posts. Forged or non-decodable design-gate-shaped bodies SHALL fail that path.

Verification for review-artifact and pipeline-attest SHALL use last-occurrence-wins semantics, SHALL require that no content follows the marker line, and SHALL require that a freshly computed hash of the preceding text equals the recorded `bodyHash`. The attestation is tamper-evidence, NOT an identity proof: it SHALL NOT by itself grant any trust, and consumers SHALL continue to check the comment author separately. A comment body carrying the attestation marker SHALL be classified `pipeline` by `classifyComment`.

The registry SHALL include a `design-interrogation` kind whose heading is `## Design Interrogation` and whose verification mode is `pipeline-attest` for newly rendered posts. New design-gate comment renders SHALL place any durable-state marker **before** the terminal `pipeline-attest` line so attestation remains last-occurrence / terminal.

There SHALL be no general unverified trust path: a pipeline-styled body that carries no verifiable artifact SHALL NOT be treated as verified pipeline output, and the objection-language patterns (`NEGATION_PATTERNS`) SHALL NOT be loosened to accommodate pipeline wording. The design-gate-state recovery path is limited to terminal decodable durable-state artifacts on design-interrogation-shaped bodies.

#### Scenario: Attested comment verifies
- **WHEN** the pipeline renders a comment type from the registry and posts it through the attesting helper
- **THEN** the posted body SHALL end with the attestation marker line
- **AND** `isVerifiedPipelineOutput` SHALL return true for that body

#### Scenario: Design-interrogation renderer verifies and self-excludes
- **WHEN** the pipeline renders a design-gate progress comment through the registered `design-interrogation` path
- **THEN** the posted body SHALL start with `## Design Interrogation`
- **AND** the body SHALL carry a durable `design-gate-state` artifact and a terminal `pipeline-attest` marker
- **AND** `isVerifiedPipelineOutput` SHALL return true
- **AND** `findUnacknowledgedComments` for a trusted author posting that body after the plan SHALL return zero unacknowledged comments

#### Scenario: Text appended after the attestation breaks verification
- **WHEN** a body that carries a valid attestation marker has additional text appended after the marker line
- **THEN** `isVerifiedPipelineOutput` SHALL return false

#### Scenario: Tampered body fails verification
- **WHEN** the text preceding an attestation marker is edited so it no longer hashes to the recorded `bodyHash`
- **THEN** `isVerifiedPipelineOutput` SHALL return false

#### Scenario: Review verdicts continue to verify through the review artifact
- **WHEN** a review verdict comment carrying a `<!-- review-artifact: … -->` record with a matching `bodyHash` is verified
- **THEN** `isVerifiedPipelineOutput` SHALL return true without requiring a separate attestation marker

#### Scenario: Terminal decodable design-gate-state verifies without pipeline-attest
- **WHEN** a design-interrogation body ends on a terminal decodable `<!-- design-gate-state: … -->` marker and carries no `pipeline-attest`
- **THEN** `isVerifiedPipelineOutput` SHALL return true
- **AND** a non-decodable or non-terminal design-gate-state shape SHALL return false

#### Scenario: Registry drift guard fails for an unattested comment type
- **WHEN** a test enumerates the registry, renders each listed comment type, and evaluates it
- **THEN** every listed type SHALL satisfy `isVerifiedPipelineOutput`
- **AND** a comment type added to the engine that does not carry a verification artifact SHALL fail this test

#### Scenario: Source drift guard fails for a comment type missing from the registry
- **WHEN** a pipeline comment heading literal exists in `core/scripts/` that is not represented in the registry and is not in the guard's justified allowlist
- **THEN** the drift-guard test SHALL fail
