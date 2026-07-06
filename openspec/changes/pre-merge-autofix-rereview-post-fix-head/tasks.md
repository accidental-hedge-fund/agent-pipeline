## 1. Carry the authoritative post-fix head back from the auto-fix

- [ ] 1.1 Change `performPreMergeAutoFix` to return the post-fix commit SHA on success
      (e.g. `{ status: "fix-committed", headSha }` or a tuple), read from local git state
      after the amend — not from a GitHub-API PR-head read.
- [ ] 1.2 Update the `AttemptPreMergeAutoFixFn` seam type and `PreMergeAutoFixResult` to
      surface the post-fix head, keeping the `"error"` result shape intact.
- [ ] 1.3 Update the production wiring that constructs the `attemptPreMergeAutoFix` seam so
      the returned head flows to the caller.

## 2. Anchor the re-review to the post-fix head

- [ ] 2.1 In the `enforceReviewShaGate` re-review branch, use the auto-fix's returned
      post-fix head as `newPrHead` instead of `getPrDetail(...).head_sha`.
- [ ] 2.2 Compute the re-review delta diff over `reviewed.sha...<post-fix-head>` from a git
      source that contains the auto-fix commit object; record the re-review comment's
      `reviewed-sha` / `verdict-diff-hash` against that same post-fix head.
- [ ] 2.3 Preserve the existing fall-through: if the post-fix head is unavailable or its
      delta diff cannot be obtained, route to the conservative full re-review without
      reusing the pre-fix diff or recording a post-fix `reviewed-sha`.
- [ ] 2.4 Keep the one-attempt bound and the review-2 ceiling exemption unchanged.

## 3. Regression tests (deps seam, no real I/O)

- [ ] 3.1 Add a test driving the fix-then-re-review path that asserts the second review
      invocation receives a diff distinct from the first, and that the recorded
      `reviewed-sha` equals the post-fix head (not the pre-fix SHA).
- [ ] 3.2 Prove the test bites: with the post-fix head resolved from the stale API read,
      the test fails.
- [ ] 3.3 Confirm the existing auto-fix tests (advance-on-resolve, escalate-on-unresolved,
      one-attempt bound, developer classification) still pass.

## 4. Mirror, docs, and verification

- [ ] 4.1 Regenerate the `plugin/` mirror (`node scripts/build.mjs`) and commit it.
- [ ] 4.2 Run `openspec validate pre-merge-autofix-rereview-post-fix-head`.
- [ ] 4.3 Run `npm run ci` from the repo root and confirm it is green.
