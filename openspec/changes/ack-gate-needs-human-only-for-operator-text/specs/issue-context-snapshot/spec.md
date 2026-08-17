## ADDED Requirements

### Requirement: Needs-human on the human-ack gate SHALL require operator-authored scope-change text

The unacknowledged-human-input gate SHALL set `blocked` with kind `needs-human` (and SHALL post `## Pipeline: New human input detected`) only for comments classified as **operator-scope-change**. Same `gh` actor as the pipeline poster SHALL NOT by itself make a comment operator-authored.

Every comment after the plan / acknowledgement anchor SHALL receive exactly one disposition from the shared classifier used by the fix-round and review-routing call sites:

1. **`pipeline-or-operational`** — the comment SHALL NOT be counted as unacknowledged human input and SHALL NOT `setBlocked` with kind `needs-human`. This disposition SHALL include:
   - verified pipeline output (`review-artifact` or `pipeline-attest` with matching `bodyHash`, or a terminal decodable design-gate durable-state artifact);
   - a trusted-actor registered review/delta heading (`## Review <N>` or `## Pre-merge Delta Review`) whose body carries a **terminal** `<!-- review-artifact: … -->` line (last occurrence; no non-whitespace after that line), even when `bodyHash` does not match;
   - a trusted-actor registered pipeline heading whose body carries a **terminal** `<!-- pipeline-attest: … -->` line, even when `bodyHash` does not match;
   - a trusted-actor **operational note** that matches the closed operational-note phrase list and does not also match the product-scope-change recognizer.
2. **`operator-scope-change`** — the comment SHALL be counted as unacknowledged human input. The fix and review call sites SHALL `setBlocked` with kind `needs-human` and SHALL NOT inject the comment into implement, review, or fix prompts. This disposition SHALL include a free-form product/scope-change comment (including “please also change X”) from a non-pipeline author, and any untrusted-author forged pipeline-styled heading or copied artifact.
3. **`ambiguous-trusted`** — a trusted-actor comment that is not verified pipeline output, is not a registered heading plus terminal artifact, is not a closed operational note, and is not a clear product-scope-change. The pipeline SHALL NOT `setBlocked` with kind `needs-human` and SHALL NOT transition to `pipeline:needs-human` solely for that set. It SHALL fail **recover** by starting the in-engine re-plan / plan-revision path so the comments become context under a new plan anchor. If that path cannot start, it MAY `setBlocked` with a recover-class kind that projects to `workflow-engine-defect`. It SHALL NOT use `needs-human` or `human-decision-required`. Until the new plan posts, those comments SHALL NOT be injected into implement, review, or fix prompts.

The closed operational-note phrase list SHALL be exported next to the classifier and SHALL include at least: `grill-lock`, `grill locked`, `grill-locked`, `ship-halt`, `ship halt`, `don't comment`, `do not comment`, `dont comment` (case-insensitive, leading line or whole trimmed body). A body that matches both an operational-note phrase and a product-scope-change clause SHALL be `operator-scope-change`.

`pipeline unblock` and verified trusted-actor operator-surface comments (`unblocked` / `finding-override` / `scope-override`) SHALL remain acknowledgement anchors. `NEGATION_PATTERNS` SHALL NOT be loosened. Forge resistance SHALL remain: an untrusted author does not receive the heading-plus-artifact or operational-note exemptions.

This requirement is the class law for false `needs-human` on this gate. The next invalid-hash review footer or unmarked factory operational note SHALL use this classifier and SHALL NOT require a new mole issue.

#### Scenario: Review-2 with instead and a valid artifact is not unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor Review-2 body
- **AND** the body contains `instead` in finding text
- **AND** the body carries a terminal `review-artifact` whose `bodyHash` matches
- **THEN** the classifier SHALL assign `pipeline-or-operational`
- **AND** `findUnacknowledgedComments` SHALL return zero comments
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human` solely for that comment

#### Scenario: Review-2 with instead and an invalid hash but a terminal artifact is not needs-human

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor Review-2 body
- **AND** the body contains `instead`
- **AND** the body carries a terminal `<!-- review-artifact: … -->` line
- **AND** `bodyHash` does not match the hashed prefix
- **THEN** the classifier SHALL assign `pipeline-or-operational`
- **AND** `findUnacknowledgedComments` SHALL NOT return that comment
- **AND** the fix and review call sites SHALL NOT `setBlocked` with kind `needs-human` solely for that comment

#### Scenario: Grill or ship-halt note without Pipeline heading does not needs-human

- **WHEN** a trusted-actor comment after the plan has no `## Pipeline:` heading and no verification artifact
- **AND** its leading line or whole body matches a closed operational-note phrase (`grill locked`, `ship-halt`, or `don't comment`)
- **AND** the body does not also contain a product-scope-change clause
- **THEN** the classifier SHALL assign `pipeline-or-operational`
- **AND** `findUnacknowledgedComments` SHALL NOT return that comment
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human`

#### Scenario: Plain please-also-change from a non-pipeline author still blocks

- **WHEN** a comment after the plan is authored by someone who is neither the pipeline actor nor a `trusted_override_actors` entry
- **AND** the body is free-form text such as “please also change X” with no pipeline heading or artifact
- **THEN** the classifier SHALL assign `operator-scope-change`
- **AND** `findUnacknowledgedComments` SHALL return that comment
- **AND** the pipeline SHALL `setBlocked` with kind `needs-human` and SHALL post the new-human-input warning

#### Scenario: Pipeline unblock still clears a real human comment

- **WHEN** an `operator-scope-change` comment remains after the plan anchor
- **AND** the operator runs `pipeline unblock` and the resulting trusted-actor `## Pipeline: Unblocked` comment is verified operator-surface output posted after that comment
- **THEN** the earlier comment SHALL no longer be counted as unacknowledged
- **AND** the resumed stage SHALL NOT `setBlocked` with kind `needs-human` solely for that earlier comment

#### Scenario: Ambiguous trusted unmarked note recovers instead of needs-human

- **WHEN** a trusted-actor comment after the plan has no registered pipeline heading or sentinel
- **AND** the body matches `NEGATION_PATTERNS` but matches neither the operational-note list nor a clear product-scope-change clause
- **THEN** the classifier SHALL assign `ambiguous-trusted`
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human`
- **AND** the pipeline SHALL start in-engine re-plan or block with a recover-class kind that projects to `workflow-engine-defect`

#### Scenario: Untrusted forged Review heading still counts

- **WHEN** a non-trusted author posts a `## Review 2` body with a copied `review-artifact` line after the plan
- **THEN** the classifier SHALL assign `operator-scope-change`
- **AND** `findUnacknowledgedComments` SHALL return that comment

#### Scenario: Human suffix after the last artifact still counts

- **WHEN** a trusted-actor Review-2 body has additional human objection text after the last `review-artifact` line
- **THEN** the artifact is not terminal
- **AND** the classifier SHALL NOT assign `pipeline-or-operational` via the heading-plus-artifact rule
- **AND** when the suffix is a product/scope change the comment SHALL be counted as unacknowledged human input

#### Scenario: Same predicate on fix and review routing

- **WHEN** the human-ack gate runs from the fix-round handler or from review routing
- **THEN** both call sites SHALL use the same classifier
- **AND** neither site SHALL apply a host-local or path-local exception

## MODIFIED Requirements

### Requirement: New human comments posted after the revised plan are detected and surfaced
After the revised plan is posted (the `## Revised Implementation Plan` comment), the pipeline SHALL detect any comment posted after the plan anchor that is unacknowledged human input, and before the next stage boundary (review or next fix round) SHALL post a single `## Pipeline: New human input detected` warning comment listing those comments and noting that a re-plan or explicit acknowledgement is required. Unacknowledged comments SHALL NOT be injected into implementation, review, or fix-round prompts.

A comment posted after the plan anchor SHALL be counted as **unacknowledged human input** UNLESS one of the following holds:

1. **Pipeline self-output (author-gated):** the comment is classified `pipeline` by `classifyComment` AND its author is the authenticated pipeline actor (`getGhActor`) or an entry in `cfg.trusted_override_actors`, AND either (a) the body is **verified pipeline output** per `isVerifiedPipelineOutput` — that is, it carries a `review-artifact` or pipeline attestation whose `bodyHash` matches the rendered body, **or** a terminal, decodable design-gate durable-state artifact (`<!-- design-gate-state: … -->`) on a design-interrogation-shaped body accepted by the design-gate verification predicate (#436 / #872 recovery for pre-attestation posts) — or (a2) the body has a registered review/delta heading and a **terminal** `review-artifact` or `pipeline-attest` line even when `bodyHash` does not match — or (b) the body carries no scope-changing / change-request language of its own. A comment classified `pipeline` whose author is **not** a trusted actor SHALL still be counted as human input — a forged pipeline-styled heading or a copied attestation from a third party does not grant self-exclusion, preserving the gate's forge resistance. A trusted actor's comment that merely mimics a pipeline heading **without** a terminal matching artifact, while carrying a genuine objection, SHALL NOT be counted as unacknowledged human input; it SHALL be `ambiguous-trusted` and recover in-engine (see the needs-human operator-scope-change requirement).
2. **Operational note:** the comment is authored by a trusted actor and matches the closed operational-note phrase list without a product-scope-change clause (see the needs-human operator-scope-change requirement).
3. **At or before an acknowledgement anchor:** the comment is at or before the effective acknowledgement anchor. The anchor is the latest of: the plan comment, a trusted-actor `## Pipeline: Scope override` comment posted after the plan, and a **plain acknowledgement**: a comment authored by a trusted actor (pipeline actor or a `trusted_override_actors` entry) that is classified `human` and contains no scope-changing / change-request language. Such a plain acknowledgement SHALL advance the anchor (dismissing prior unacknowledged human comments) and SHALL NOT itself be counted.

The verified-output exemption in rule 1(a) exists because the pipeline's own generated bodies routinely use objection wording — review findings quote defects, design-gate challenge titles recommend revisions, and transition comments explain why an item advanced *instead* of routing to a fix round. It SHALL apply to **any** attested comment type and to terminal decodable design-gate durable-state artifacts, not only review verdicts. Rule 1(a2) is the residual integrity path: a terminal artifact blob on a registered heading is still pipeline structure when the hash fails. Non-decodable or non-terminal design-gate-shaped bodies SHALL fail closed. Human text after the last artifact line SHALL fail the terminal-artifact rule.

Because the pipeline posts under the operator's own `gh` identity in single-operator repos, self-exclusion SHALL rely on the comment's structural markers, terminal artifacts, and the operational-note list rather than on a distinct bot login; the author check only distinguishes the trusted actor from third parties.

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
- **THEN** the comment SHALL NOT be counted as unacknowledged human input
- **AND** the classifier SHALL assign `ambiguous-trusted`
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human` solely for that comment
- **AND** the pipeline SHALL recover in-engine (re-plan or recover-class block) rather than park as human

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
- **AND** the comment is not a closed operational note
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
- **AND** the comment is not a registered heading with a terminal artifact
- **AND** the comment is not a closed operational note
- **THEN** that comment SHALL NOT act as an acknowledgement anchor
- **AND** if it is a clear product-scope-change it SHALL be counted as unacknowledged human input
- **AND** if it is only `ambiguous-trusted` it SHALL recover in-engine and SHALL NOT `setBlocked` with kind `needs-human`

#### Scenario: Multiple unacknowledged comments are batched into one warning
- **WHEN** three unacknowledged human comments are posted after the revised plan before the pipeline reaches the next stage boundary
- **THEN** the pipeline SHALL post exactly one `## Pipeline: New human input detected` comment listing all three comments
- **AND** the pipeline SHALL NOT post one warning per comment

### Requirement: Verified review comments with engine-owned banners SHALL NOT trip the human-ack gate

The unacknowledged-human-input gate SHALL treat a trusted-actor review-1, review-2, or pre-merge delta comment as pipeline self-output when `isVerifiedPipelineOutput` is true for the posted body, including when that body carries engine-owned coverage / ensemble / self-review banners. Objection-pattern wording in the verified body (`instead`, `do not`, and the rest of `NEGATION_PATTERNS`) SHALL NOT cause `findUnacknowledgedComments` to return that comment.

The gate SHALL also treat a trusted-actor review/delta heading plus a **terminal** `review-artifact` blob as pipeline self-output when `bodyHash` does not match. That residual is engine integrity, not human authority. A heading-only body with no terminal artifact SHALL NOT receive this exemption. A free-form human comment after the revised-plan anchor SHALL still be counted when it is operator-scope-change. A human suffix after the last artifact line SHALL still be counted when it is a product/scope change.

This requirement does not loosen `NEGATION_PATTERNS` and does not change author-trust rules. It supersedes the prior residual that an unverified review-shaped trusted body with `NEGATION_PATTERNS` still counted as human.

#### Scenario: Bannered review-2 with instead does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor review-2 body
- **AND** that body includes a `**Reviewer coverage (#694):**` banner and finding text matching `\binstead\b`
- **AND** `isVerifiedPipelineOutput` is true for that body
- **THEN** `findUnacknowledgedComments` SHALL return zero unacknowledged comments
- **AND** the pipeline SHALL NOT set `blocked` / `needs-human` solely because of that review comment

#### Scenario: Bannered review-1 with objection wording does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor review-1 body that verifies after engine-owned banners
- **AND** the body contains wording matching `NEGATION_PATTERNS`
- **THEN** `findUnacknowledgedComments` SHALL NOT return that comment

#### Scenario: Bannered delta review with objection wording does not count as unacknowledged

- **WHEN** the only comment after the revised-plan anchor is a trusted-actor pre-merge delta review body that verifies after engine-owned banners
- **AND** the body contains wording matching `NEGATION_PATTERNS`
- **THEN** `findUnacknowledgedComments` SHALL NOT return that comment

#### Scenario: Real human comment after the revised plan still counts

- **WHEN** a free-form human comment with no pipeline verification artifact is posted after the revised-plan anchor
- **AND** the comment is not a closed operational note
- **THEN** `findUnacknowledgedComments` SHALL return that comment
- **AND** the pipeline SHALL block the stage boundary until re-plan or a trusted acknowledgement / override path clears it

#### Scenario: Unverified review-shaped body with objection wording still counts

- **WHEN** a trusted-actor comment after the plan uses a review heading and contains `NEGATION_PATTERNS` wording
- **AND** `isVerifiedPipelineOutput` is false for that body
- **AND** the body carries a terminal `review-artifact` line
- **THEN** `findUnacknowledgedComments` SHALL NOT count the comment as unacknowledged human input
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human` solely for that comment

#### Scenario: Production banner prefix with appended human text still counts

- **WHEN** a trusted-actor review-shaped comment after the plan has a stale `bodyHash` computed without banners
- **AND** a line between the heading and `**Reviewer**:` starts with a production coverage, ensemble, or self-review banner prefix and continues with `NEGATION_PATTERNS` wording
- **AND** the last `review-artifact` line is still terminal
- **THEN** `isVerifiedPipelineOutput` SHALL be false
- **AND** `findUnacknowledgedComments` SHALL NOT count the comment as unacknowledged human input
- **AND** the pipeline SHALL NOT `setBlocked` with kind `needs-human` solely for that comment
