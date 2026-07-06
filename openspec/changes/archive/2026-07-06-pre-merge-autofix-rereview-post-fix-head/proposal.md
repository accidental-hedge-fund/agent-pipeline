## Why

The pre-merge bounded auto-fix (#359/#364) commits a fix for a blocking correctness
finding, pushes it to the PR head, then re-runs the delta review exactly once. That
re-review is supposed to evaluate the diff **including** the auto-fix commit — but in
practice it re-reviews the **pre-fix** diff and re-emits the very finding the auto-fix
just resolved, blocking with `needs-human`.

Root cause: after `performPreMergeAutoFix` commits and pushes, the caller resolves the
"post-fix head" by reading `getPrDetail(...).head_sha` from the GitHub API
(`gh pr view --json headRefOid`). That API read is stale in the short window right after
a push, so it returns the **pre-fix** head. The re-review diff is then computed as
`reviewed.sha...<stale-head>` — byte-identical to the first review — and the re-review
comment records `reviewed-sha: <pre-fix-sha>`. The auto-fix commit SHA is already known
authoritatively from local git state in the issue worktree, but that authoritative value
is discarded in favor of the racy API read.

Evidence (issue #349, PR #368, 2026-07-03), observed twice in one convergence: an
auto-fix that implemented exactly the recommended remediation still re-blocked, with the
verdict comment anchored to the pre-fix `reviewed-sha` and **byte-identical prompt sizes**
across both review invocations (23,312 chars in round A, 26,676 chars in round B). A fresh
`/pipeline N` run after a manual unblock reviewed the true head (prompt size changed) and
the finding did not recur. Every successful auto-fix therefore still costs a manual verify
+ unblock + re-run cycle, defeating the feature's purpose.

## What Changes

- Anchor the pre-merge auto-fix re-review to the **authoritative post-fix head** — the SHA
  of the auto-fix commit as produced in the local issue worktree — instead of a
  possibly-stale GitHub-API PR-head read. The successful auto-fix result carries this SHA
  back to the caller so no re-read is needed.
- Compute the re-review's delta diff over `reviewed.sha...<post-fix-head>` from a git
  source that actually contains the post-fix commit object, and record the re-review
  verdict comment's `reviewed-sha` / `verdict-diff-hash` sentinels against that same
  post-fix head.
- If the authoritative post-fix head or its delta diff cannot be obtained, fall through to
  the conservative full re-review (existing #359 R2 F1 discipline) rather than reusing the
  pre-fix diff or recording a post-fix `reviewed-sha` over a stale diff.
- Add a regression test that drives the fix-then-re-review path through the deps seam and
  asserts the second review invocation receives a **different** (post-fix) diff than the
  first, with the recorded `reviewed-sha` equal to the post-fix head.

Rigor-preserving: the re-review still runs exactly once and can still block on genuinely
unresolved or new findings; no review coverage is removed. Out of scope: the review-SHA
gate's internal-commit classification (#16/#98) and the bounded-fix category allowlist
(#359) are unchanged.

## Acceptance Criteria

- [ ] After the pre-merge auto-fix commits and pushes, the re-review's delta diff is
      computed from the authoritative post-fix head (the auto-fix commit SHA), not a
      GitHub-API PR-head read that may be stale immediately after the push.
- [ ] The re-review verdict comment's `reviewed-sha` (recorded `commitSha`) equals the
      post-fix head (the auto-fix commit SHA), never the pre-fix SHA.
- [ ] A finding whose remediation the auto-fix applied does not re-block the run when the
      post-fix delta diff no longer exhibits it.
- [ ] The second review invocation receives a diff distinct from the first; a regression
      test through the deps seam asserts the two review invocations get different diffs and
      that the re-review is anchored to the post-fix head, and the test bites if the
      post-fix head plumbing is reverted to the stale API read.
- [ ] When the authoritative post-fix head or its delta diff cannot be obtained, the
      pipeline falls through to the conservative full re-review rather than reusing the
      pre-fix diff or recording a post-fix `reviewed-sha` over a stale diff.
- [ ] The re-review still runs exactly once, still consumes no review-2 ceiling slot, and
      can still block on genuinely unresolved or new findings (no reduction in review
      coverage).

## Capabilities

### Modified Capabilities
- `pre-merge-fix-round`: The single post-auto-fix delta re-review is anchored to the
  authoritative post-fix head (the auto-fix commit SHA from local git state), so the
  re-reviewed diff includes the fix and the recorded `reviewed-sha` is the post-fix head.

## Impact

- Affected code: `core/scripts/stages/pre_merge.ts` (the `performPreMergeAutoFix` result
  shape and the re-review branch in `enforceReviewShaGate`), co-located tests, and any
  wiring that constructs the `attemptPreMergeAutoFix` seam.
- Behavior: no change to which findings qualify for auto-fix, to the one-attempt bound, or
  to the review-SHA gate's internal-commit classification.
- Generated mirror: `plugin/` must be regenerated from `core/` (`node scripts/build.mjs`).
