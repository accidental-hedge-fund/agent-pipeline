## 1. Type Changes

- [x] 1.1 Add `commitSha: string` field to the `ReviewVerdict` type in `core/scripts/types.ts`
- [x] 1.2 Update any `ReviewVerdict` construction sites to pass `commitSha` (compile-check driven)

## 2. SHA Capture at Review Time

- [x] 2.1 In the review stage (`core/scripts/stages/review.ts`), resolve the current HEAD SHA via `git rev-parse HEAD` (or GitHub API) before invoking the reviewer
- [x] 2.2 Pass the resolved SHA into `parseStructuredVerdict` (or attach it after parsing) so every returned verdict has `commitSha` set

## 3. Embed SHA in Review Comment

- [x] 3.1 Update the review comment template to append the hidden sentinel `<!-- reviewed-sha: <full-sha> -->` as the last line of every posted review comment
- [x] 3.2 Update the comment header/footer to include the short SHA (first 7 chars) in human-readable form

## 4. SHA Extraction from Prior Comments

- [x] 4.1 Write (or extend) `extractReview1Summary` / add `extractReviewedSha(comments, round)` that reads the `<!-- reviewed-sha: ... -->` sentinel from the most recent review comment for a given round
- [x] 4.2 Return `null` (treated as stale) when no sentinel is found

## 5. Gate Transition SHA Check

- [x] 5.1 At each gate point that reads a prior review verdict, call `extractReviewedSha` and compare to current HEAD
- [x] 5.2 If SHA matches, proceed with existing verdict routing (no change)
- [x] 5.3 If SHA is missing or mismatched, post the stale-verdict notice comment (`Re-running review: HEAD has moved from <old> to <new>...`) and re-invoke the review stage
- [x] 5.4 Ensure the re-invoked review stage records the new SHA in its comment

## 6. Tests

- [x] 6.1 Unit test: `parseStructuredVerdict` output includes `commitSha` field set to the supplied SHA
- [x] 6.2 Unit test: `extractReviewedSha` returns the correct SHA when sentinel is present
- [x] 6.3 Unit test: `extractReviewedSha` returns `null` when no sentinel is present (legacy comment)
- [x] 6.4 Unit test: gate check with matching SHA — verdict routing proceeds normally, no re-review invoked
- [x] 6.5 Unit test: gate check with mismatched SHA — re-review is triggered, stale notice is posted
- [x] 6.6 Unit test: gate check with `null` SHA (no sentinel) — re-review is triggered
- [x] 6.7 Regression test: existing needs-attention + zero-findings retry behavior is unaffected by SHA field

## 7. Validation

- [x] 7.1 Run `pnpm test` — all tests pass
- [x] 7.2 Manually verify review comment output includes both the hidden sentinel and the visible short SHA
