# Design

## Context

The human-input gate lives in `findUnacknowledgedComments` (`core/scripts/issue-context-snapshot.ts`), consumed by `review-routing.ts` and `fix.ts` before a stage boundary. It:
1. Finds the plan anchor (`## Revised Implementation Plan`, else `## Implementation Plan`).
2. Optionally advances the anchor to a trusted `## Pipeline: Scope override` comment.
3. Counts every post-anchor comment where `classifyComment(body) === 'human'`.

`classifyComment` (`core/scripts/gh.ts`) is pure body-classification against `PIPELINE_COMMENT_HEADERS`. That list omits `## Pre-merge Delta Review` (the header both delta-review verdict and follow-up re-review use, via `formatDeltaReviewComment` → `DELTA_REVIEW_MARKER_PREFIX`) and only lists `## Review 1`/`## Review 2`. So the pipeline's own pre-merge review output is misclassified as human input — and in single-operator repos the author is the operator, so author cannot rescue it.

## The reconciled classification/exclusion rule

Issue AC1 ("recognize pipeline bodies … regardless of author login") and AC2 ("marker-based exclusion applies only to comments authored by the pipeline actor") read as a tension. They reconcile once you observe that **the pipeline actor == the operator** in the single-identity case:

- **Recognition is body-only** (`classifyComment`): a `## Pre-merge Delta Review` body is structurally pipeline output no matter who posted it. This is AC1 — recognition does not depend on a dedicated bot login.
- **Exclusion is author-gated** (the gate): a structurally-pipeline comment is dropped from the count only when its author is trusted (actor or `trusted_override_actors`). This is AC2 — a third party forging the heading is still counted.

In the single-operator flow both the pipeline's comments and the operator's genuine comments share the operator's login, which *is* the actor, so the pipeline's structured comments are correctly excluded "under the operator's login" while forgeries from other authors are not. This is exactly the trust model `buildTrustedOverrideComments` already encodes (#229 Finding 6, #318 fix c5825398): body-prefix heuristics are forgeable, so trust flows from author identity, never from the body alone.

**Decision:** keep `classifyComment` pure (body-only) — many consumers use it for snapshot building where author-gating is irrelevant — and apply the author check inside the gate, where forge resistance matters. The gate already receives the trusted-actor comment set (`buildTrustedOverrideComments(detail.comments, actor, cfg.trusted_override_actors)`), so no new `getGhActor` call or new plumbing is required.

Concretely, a post-anchor comment counts as unacknowledged human input iff:
`classifyComment(body) === 'human'` OR (`classifyComment(body) === 'pipeline'` AND author ∉ trusted set).
Equivalently: exclude only trusted-authored structurally-pipeline comments.

## Marker set

- Add `## Pre-merge Delta Review` (the concrete castrecall #45 gap).
- Generalize `## Review 1`/`## Review 2` → `## Review <N>` (N a positive integer). Adversarial rounds are bounded today, but the issue names `## Review N` explicitly and a `## Review 3` posted by a future config must not gate.
- Recognize pipeline machine-sentinel HTML markers as structural. These already uniquely identify pipeline output (they are what the audit/override/blocking-keys/reviewed-sha machinery reads back) and give a heading-independent recognition path. They only ever *exclude* when author-trusted, so adding them cannot weaken forge resistance.

## Plain-acknowledgement anchor (AC4)

Today only a trusted `## Pipeline: Scope override` comment advances the anchor. The evidence shows the operator's plain explanatory comment then becomes a fresh unacknowledged item, re-blocking the resume. 

**Decision:** treat a trusted-actor comment posted after the plan anchor that contains **no scope-changing language** as an acknowledgement anchor — the same anchor-advancement semantics as a scope-override, minus the magic heading. "Scope-changing language" reuses the existing `NEGATION_PATTERNS` (the change-request/objection set already used by `detectConflicts`), so this change does not invent or alter the keyword set (explicitly out of scope). A trusted comment that *does* match those patterns is a genuine change request and still gates (AC5); a comment from a non-trusted author never anchors.

**Tradeoff (surfaced):** an anchor dismisses prior unacknowledged human comments. A plain trusted-actor acknowledgement therefore dismisses any earlier genuine concern from that actor. This matches existing scope-override anchor semantics and is acceptable in the single-operator model where the trusted actor owns those prior comments; it is the operator explicitly saying "proceed." We keep the negation-pattern guard precisely so that an operator comment that still voices a concern does not silently self-dismiss.

## Alternatives considered

- **Add `## Pre-merge Delta Review` to `PIPELINE_COMMENT_HEADERS` only, no author gate.** Fixes castrecall #45 but leaves the gate forgeable by any commenter posting the heading — regresses #229/#318 forge resistance. Rejected.
- **Make `classifyComment` author-aware.** Would ripple into snapshot-building and other pure consumers and muddy a well-tested pure function. Rejected in favor of gate-local author gating.
- **A dedicated bot identity for pipeline comments.** Out of scope by the issue; the fix must work in the single-identity case.

## Testing

Drive `findUnacknowledgedComments` and `classifyComment` through the existing deps seam (no network/git). Cover: delta-review self-output excluded (actor login), forged heading from another author counted, plain-ack anchor (prior dismissed, ack not re-counted), scope-relevant trusted comment counted, and `classifyComment` unit cases for the new markers. Each test must fail against pre-change behavior to prove it bites.
