## Context

OpenSpec authoring happens at planning time, before review. The state machine has no edge from review back to planning — the lowest a review bounces is a fix round, and fix rounds edit code only. The fix prompt discourages touching anything "unrelated to the review findings"; the spec section framed deltas as immutable truth ("must satisfy"). The pre-merge archive (`maybeArchiveOpenspec`) called `openspec archive` unconditionally, without checking whether the change's spec still matched the implementation.

## Goals / Non-Goals

**Goals**
- Fix rounds may (and are instructed to) update spec deltas when a finding's resolution changes described behavior; the harness re-validates the change afterward.
- The pre-merge stage detects and blocks on code-spec divergence before archiving, with an explicit error instead of silently archiving a stale delta.
- The fix path stays conservative: no finding implying a spec-level change → no spec edits.

**Non-Goals**
- A new review→planning edge (Option b from #106). Deferred to v1.1.0 if Option a proves insufficient.
- Semantic diff between spec text and code.

## Decisions

**Decision: the pre-merge guard is a total function over structured/deterministic inputs — never prose.**
The guard blocks only when ALL of: (1) a deterministic git file-path check shows impl files changed after the last `specs/**` change (order-aware), and (2) the most recent review verdict carries a finding tagged **`category: "spec-divergence"`**, read from the controlled marker `formatReviewComment` emits (`reviewCommentFlagsSpecDivergence`). Keyword-matching the reviewer's free-text prose to infer divergence is adversarially unwinnable — it oscillates false-positive ↔ false-negative forever (this was the failure of the superseded PR #109). A structured field the reviewer sets and we read exactly is winnable. To give condition (2) a signal, the review prompts' severity rubric already instructs the reviewer to tag findings with a `category` (with `spec-divergence` listed).

**Decision: two-condition AND (not file-path alone).** Condition (1) alone over-blocks — almost every fix changes code without touching specs. Condition (2) scopes the guard to genuinely spec-material divergence the reviewer actually saw. Missing either → proceed (conservative-open).

**Decision: reframe `specContextSection` "must satisfy" → "must stay consistent with".** Preserves the constraint while permitting a deliberate spec revision when the finding implies the spec itself was wrong. Single-line wording change.

**Decision: structural `openspec validate <id>` after a fix revises a delta.** Deterministic backstop that the revised delta is well-formed; semantic adequacy is a reviewer concern (the #16 SHA gate re-reviews the spec-updating commit).

**Decision: deps/fake seam pattern.** `maybeArchiveOpenspec` and `enforceSpecConsistencyGuard` take injectable deps (branch-commit reader, issue-detail reader, setBlocked) so the guard is unit-tested with no real git, openspec CLI, or GitHub.

## Risks / Trade-offs

- *Fix harness ignores the spec-revision instruction* → the `openspec validate <id>` check and the re-review triggered by the #16 SHA gate are two layers of catch; the pre-merge guard is the hard backstop.
- *Guard false-positive on a valid "spec didn't need to change" fix* → requires BOTH the file-path signal AND a `category: spec-divergence` finding, so it fires only when the reviewer flagged divergence. The escape is to bring the delta into agreement (any `specs/**` commit clears it). Even if the divergence finding is a false positive, updating the delta to state actual behavior is strictly better than archiving an unverified delta. (The guard is NOT keyed off `--override`: that governs review-routing severity, not the archive layer.)
