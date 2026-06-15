## 1. Stable Key Algorithm

- [x] 1.1 Add `lineBucket(line_start: number | undefined): number` helper to `core/scripts/review-policy.ts`: `Math.floor((line_start - 1) / 5) * 5 + 1`, returning 0 when `line_start` is absent/falsy/< 1
- [x] 1.2 Add `normalizeFile(file: string | undefined): string` helper to `core/scripts/review-policy.ts`: `(file ?? "").toLowerCase()`
- [x] 1.3 Add `normalizeTitle(title: string | undefined): string` helper to `core/scripts/review-policy.ts`: lowercase, strip markdown emphasis chars (`*`, `_`, backtick, `~`), strip leading/trailing `…`/`...`/punctuation, collapse whitespace, trim
- [x] 1.4 Replace the `findingKey()` implementation to use `sha1(severity | normalizeFile(file) | lineBucket(line_start))` when `line_start` is present (> 0), and `sha1(severity | normalizeFile(file) | normalizeTitle(title))` as fallback

## 2. Tests

- [x] 2.1 Update `core/test/review-policy.test.ts`: existing `findingKey` tests updated to reflect the new algorithm (none asserted literal hashes; relationship assertions reframed around the location-based key + title fallback)
- [x] 2.2 Add stable-key property tests: finding with same severity + file + line_start (±4 lines within the same bucket) but different titles → same key
- [x] 2.3 Add specificity tests: findings at different 5-line bands → different keys; findings at different severities → different keys; findings at different files → different keys
- [x] 2.4 Add fallback tests: when `line_start` is absent, findings with different normalized titles → different keys; findings with the same normalized title (after markdown/capitalization normalization) → same key
- [x] 2.5 Add the #144 regression test: a finding at file `f`, line `L`, severity `high`, title `T1` overridden in round N; in round N+1 the same finding is re-emitted at line `L+2` (same bucket) with title `T2` (reworded); `findingKey` returns the same 8-char hex for both → override still applies and `partitionFindings` does not count it as blocking

## 3. Recurrence Detection Consistency

- [x] 3.1 Verified `review.ts` uses `findingKey()` (not an inline alternative) for both the punch-list RECURRING/NEW tagging (keys emitted via `findingKey` and read back) and the early-park recurrence check (`partition.blocking.filter((f) => priorKeys.has(findingKey(f)))`) — single-sourced, no inline formula; stale algorithm comments updated
- [x] 3.2 Add a unit test: a finding re-emitted with a reworded title + ±2-line shift at the same location is tagged RECURRING (not NEW) and early-parks at `needs-human` (exercises the actual recurrence path in `advanceReview` + `recurrenceTag`; there is no `buildRecurrenceMap` function in the codebase)

## 4. Review Comment Display

- [x] 4.1 Confirmed `formatReviewComment` in `review.ts` calls `findingKey(f)` for the displayed `override-key: <key>` — the displayed key automatically reflects the new algorithm; no code change needed
- [x] 4.2 Added a `MIGRATION` note to `findingKey()` documenting that in-flight `pipeline-override` sentinels recorded before this change carry old-algorithm keys and must be re-recorded (ships ~2026-06, #144)

## 5. Spec Sync

- [x] 5.1 Run `openspec validate override-stable-finding-identity` — reports "is valid"

## 6. CI

- [x] 6.1 Run `npm run ci` from repo root — 793 tests pass, mirror in sync, install-smoke green, exit 0

## 7. Review-2 Findings (fix round 2)

- [x] 7.1 [HIGH] Ambiguous-key guard: update `partitionFindings` to count key occurrences; withhold override when two or more findings share the same key in the current verdict — leave all of them blocking
- [x] 7.2 [HIGH] Ambiguous-key test: add `partition: ambiguous override (two distinct findings share the same key)` test to `review-policy.test.ts`
- [x] 7.3 [HIGH] Spec update: add "Ambiguous override" scenario to `specs/review-severity-policy/spec.md`; clarify "Overridden finding stops blocking" scenario to say "exactly one finding"
- [x] 7.4 [HIGH] Design update: revise D1 consequence — collision now withholds the override from both findings (not "overrides both")
- [x] 7.5 [MEDIUM] Proposal update: replace misleading "within ±4 lines" with "within the same 5-line band" in acceptance criterion
- [x] 7.6 [MEDIUM] Design update D2: clarify that cross-bucket drift does not survive the override (intentional; not a promise of ±4 unconditional tolerance)
