## 1. Embed diff-hash sentinel in review comments

- [ ] 1.1 Implement `computeDiffHash(diff: string): string` in review.ts — returns the first 16 hex characters of the SHA-256 digest of the raw diff string.
- [ ] 1.2 `formatReviewComment` receives the computed diff hash and appends `<!-- verdict-diff-hash: <hash> -->` to the comment footer alongside the existing `reviewed-sha` sentinel.
- [ ] 1.3 `advanceReview` passes the already-fetched diff to `formatReviewComment` so the stored hash matches the exact string the reviewer evaluated.

## 2. Verdict cache check on review stage re-entry

- [ ] 2.1 Implement `extractDiffHashFromComment(body: string): string | null` in review.ts — anchored full-line regex, last-occurrence-wins (identical guard to `extractBlockingKeysFromComment`); returns `null` when absent or malformed.
- [ ] 2.2 Before invoking the reviewer in `advanceReview`, look up the prior review-N comment (already fetched via `getIssueDetail`), extract its diff-hash sentinel, and compare to the current diff hash. On a match, log "Diff hash unchanged; reusing cached verdict for round N" and return the cached routing result without calling `runReviewFn`.
- [ ] 2.3 On a cache miss, invoke the reviewer as normal and embed the new hash in the posted comment (via 1.2).
- [ ] 2.4 Injectable `deps` seam: the existing `AdvanceReviewDeps` gains no new required fields — the diff is already fetched and the hash is computed inline. Confirm the fake seam still covers the cache-hit and cache-miss branches.

## 3. Diff-hash check in the pre-merge SHA gate

- [ ] 3.1 Add `getPrDiff` to `ShaGateDeps` (optional, defaults to the real `getPrDiff`).
- [ ] 3.2 In `enforceReviewShaGate`, after the pipeline-internal commit check returns "re-review needed", fetch the current PR diff hash and extract the cached hash from the prior review comment. If they match, return `null` (verdict valid, no re-review needed), posting a brief notice: "Diff unchanged since last review; verdict reused."
- [ ] 3.3 On a hash mismatch (diff changed), proceed to the delta review path (task 4).

## 4. Delta review path in pre-merge

- [ ] 4.1 Implement `getCommitDeltaDiff(cfg, prNumber, baseSha, headSha, deps): Promise<string>` — returns the diff of `baseSha...headSha` using `gh pr diff --patch`-equivalent for a commit range. Injectable seam in `ShaGateDeps`.
- [ ] 4.2 In `enforceReviewShaGate` (diff-changed path), invoke the adversarial reviewer (round-2 prompt, same `runReviewFn` as review-2) against the delta diff instead of routing the issue back to `review-2`. The delta review prompt SHALL state that these are unreviewed changes since the last approved review.
- [ ] 4.3 Post the delta-review verdict as a comment embedding both the new `reviewed-sha` sentinel (current HEAD) and the new `verdict-diff-hash` sentinel.
- [ ] 4.4 Delta review `approve` → return `null` from `enforceReviewShaGate` (pre-merge proceeds). Delta review blocking findings → block pre-merge with reason "Pre-merge delta review found blocking findings; fix required before merging." Routes via the normal `setBlocked` path.
- [ ] 4.5 Add `runDeltaReview` (or equivalent) as an injectable dep in `ShaGateDeps` so delta review branches can be unit-tested with fakes.

## 5. Tests

- [ ] 5.1 `computeDiffHash` — deterministic: same input returns same hash; different input returns different hash.
- [ ] 5.2 `extractDiffHashFromComment` — present: returns correct hash; absent: returns null; malformed sentinel: returns null; spoofed earlier occurrence: last occurrence wins.
- [ ] 5.3 `advanceReview` cache hit — prior comment contains matching diff hash → `runReviewFn` is NOT called; cached verdict routes correctly.
- [ ] 5.4 `advanceReview` cache miss — prior comment has different or absent hash → `runReviewFn` IS called; new hash embedded in posted comment.
- [ ] 5.5 `enforceReviewShaGate` diff-hash match — SHA mismatch but same diff hash → returns `null` (no re-review); notice comment posted.
- [ ] 5.6 `enforceReviewShaGate` delta approve — SHA mismatch, diff hash changed, delta review returns approve → returns `null` (pre-merge proceeds); comment embeds new SHA and hash.
- [ ] 5.7 `enforceReviewShaGate` delta blocking — SHA mismatch, diff hash changed, delta review returns blocking findings → pre-merge is blocked with expected reason; does not transition to `review-2`.
- [ ] 5.8 `enforceReviewShaGate` pipeline-internal exemption unchanged — only archive commits since review → returns `null` without checking diff hash (existing behavior preserved).

## 6. Mirror + CI

- [ ] 6.1 `node scripts/build.mjs`; `npm run ci` green.
