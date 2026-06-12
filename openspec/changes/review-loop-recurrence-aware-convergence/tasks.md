## 1. Pure Helper — Blocking Key Extraction

- [x] 1.1 Add `extractBlockingKeysFromComment(body: string): Set<string>` to `core/scripts/stages/review.ts` — regex over `` `override-key: <8-hex>` `` tokens, returning a `Set<string>`, no side-effects
- [x] 1.2 Write unit tests: comment with findings → correct key set; approve comment (no findings) → empty set; empty/malformed body → empty set; multiple findings → all keys present
- [x] 1.3 Prove each test bites (fails without the implementation)

## 2. RECURRING / NEW Tagging in `reviewCeilingComment`

- [x] 2.1 Add `priorReviewComments: { body: string }[]` parameter to `reviewCeilingComment`; compute per-finding recurrence count by scanning each body with `extractBlockingKeysFromComment`
- [x] 2.2 Prepend `RECURRING (n rounds)` or `NEW` tag to each finding line in the punch-list output
- [x] 2.3 Update all call-sites of `reviewCeilingComment` to pass the prior Review-N comment subset from `detail.comments`
- [x] 2.4 Write unit tests: finding key present in 2 prior comments → `RECURRING (2 rounds)`; finding key absent from all prior comments → `NEW`; no prior comments → all `NEW`

## 3. Early Park on Recurrence in `advanceReview`

- [x] 3.1 After the advisory-advance path and before the ceiling check, extract the immediately-prior Review-N comment body (last comment in `detail.comments` whose body starts with `## Review {round}`) using existing `findLatestCommentMatching` / iteration pattern
- [x] 3.2 Call `extractBlockingKeysFromComment` on that body; if the intersection with the current round's blocking `findingKey` set is non-empty, post the tagged punch-list comment and transition to `needs-human` (mirror the ceiling branch structure)
- [x] 3.3 Write unit tests (with `AdvanceReviewDeps` seam): two-round scenario where round 2 re-emits a round-1 key → early park + `needs-human` transition recorded; round 2 emits only new keys → no early park, routes to fix; no prior comment → no early park
- [x] 3.4 Prove each test bites (fails without the recurrence check)

## 4. RECURRING / NEW Tagging in `needsHumanPunchlist`

- [x] 4.1 Update `needsHumanPunchlist` in `core/scripts/stages/pre_merge.ts` (or wherever defined): for each finding line parsed from the ceiling comment, extract its key and count how many prior Review-N comment bodies (from the same `comments` array) contain that key via `extractBlockingKeysFromComment`; append `RECURRING (n rounds)` or `NEW` to the line
- [x] 4.2 Write unit tests: findings with prior-round history → `RECURRING (n rounds)` in output; new findings → `NEW`; finding line with no parseable key → `NEW` by default; no prior Review-N comments → all `NEW`

## 5. CI Gate

- [x] 5.1 Run `npm run ci` from repo root and confirm all tests pass (core tests + mirror-sync check + install smoke)
- [x] 5.2 Regenerate `plugin/` mirror: `node scripts/build.mjs`, commit alongside `core/` changes in same changeset
