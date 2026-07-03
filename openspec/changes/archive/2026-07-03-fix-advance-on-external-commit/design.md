## Context

The fix stage (`advanceFix` in `core/scripts/stages/fix.ts`) captures `headBefore`
before invoking the fix harness and `headAfter` after. When they are equal the
harness produced no commit. The pipeline first tries to salvage uncommitted work
(`trySalvageUncommittedWork`); if the worktree is clean it blocks with
`"fix-N reported success but produced no new commits."` (`blockerKind: "no-commits"`).

That block path assumes "no new commit since I started ⇒ no work was done." That
assumption is false when a human (or a prior run) already committed the fix and
pushed it: `headBefore` already contains that commit, so `headBefore === headAfter`,
the worktree is clean, and the stage wrongly blocks. The reviewer, however, has
*not* seen that commit — the SHA it last reviewed (`review_sha`) is behind HEAD.
Advancing lets the next review round evaluate the already-applied fix, which is
exactly what the reviewer wants.

## Goals / Non-Goals

**Goals**
- The fix stage advances when it produces no new commit but HEAD carries commits
  the reviewer has not yet reviewed.
- The fix stage still blocks when HEAD equals the reviewed SHA (nothing was done)
  or when no reviewed SHA can be established (fail closed).
- No new SHA-tracking mechanism: reuse `extractReviewedSha`, the same helper the
  pre-merge OpenSpec consistency guard already uses.

**Non-Goals**
- Changing the salvage path or the harness invocation.
- Adding a state-machine edge — the advance targets are the fix stage's existing
  next stages (`review-2` for round 1, `pre-merge` for round 2).
- Comparing HEAD against the *base branch* or PR head via a network call; the
  decision uses only the review comments already fetched into `detail`.

## Decisions

**Decision: compare HEAD to the reviewed SHA, not to `headBefore`.** The bug is
that `headBefore === headAfter` conflates "the harness did nothing this run" with
"nothing needs doing." The reviewed SHA is the correct baseline for "has the
branch moved past what the reviewer saw." `extractReviewedSha` reads the trusted
review comment's `reviewed-sha` sentinel / artifact SHA — the authoritative
answer to that question — and it is already imported and used elsewhere in the
fix path's consistency guard, so there is no new dependency.

**Decision: fail closed on a missing or unparseable review SHA.** If
`extractReviewedSha` returns `null` or `{ sha: null }` (no review comment, or a
legacy comment without a SHA), the pipeline cannot prove the branch has advanced
past a review, so it blocks as today. Advancing on an unknown baseline could skip
a genuinely-empty fix round. This matches the fail-closed pattern already used for
the trusted-actor resolution earlier in `advanceFix`.

**Decision: reuse the already-fetched `detail.comments`.** `advanceFix` fetches
`getIssueDetail` at the top; the reviewed-SHA lookup runs against those comments
with no extra `gh` call, keeping the no-commit path free of new network I/O and
directly unit-testable through the existing test seams.

**Decision: only trusted-author review comments count.** The reviewed-SHA lookup
must not honor a SHA marker forged by an untrusted commenter. `advanceFix` already
resolves the trusted review author (`trustedReviewAuthor`) for the consistency
guard; the reviewed-SHA extraction reuses that same trusted-comment filtering so
an untrusted comment cannot fabricate a "HEAD moved past review" signal to force
an advance.

## Risks / Trade-offs

- *Advancing on a stale/incorrect review SHA* → the next stage is a review round
  (round 1 → `review-2`) or the pre-merge gate (round 2 → `pre-merge`); both
  re-examine the branch, so an erroneous advance is caught downstream rather than
  shipping unreviewed. The #16 SHA gate re-reviews when HEAD is past the reviewed
  SHA, so round-2 → pre-merge does not skip review of the new commits.
- *Fail-closed on missing SHA re-introduces the manual label-advance for
  SHA-less legacy comments* → acceptable: those are rare, and advancing without a
  provable baseline is the more dangerous failure mode.
