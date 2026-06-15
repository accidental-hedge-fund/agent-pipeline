## 1. Stable Key Algorithm

- [ ] 1.1 Add `linebucket(line_start: number | undefined): number` helper to `core/scripts/review-policy.ts`: `Math.floor(((line_start ?? 0) - 1) / 5) * 5 + 1` returning 0 when `line_start` is absent/falsy
- [ ] 1.2 Add `normalizeFile(file: string | undefined): string` helper to `core/scripts/review-policy.ts`: `(file ?? "").toLowerCase()`
- [ ] 1.3 Add `normalizeTitle(title: string | undefined): string` helper to `core/scripts/review-policy.ts`: lowercase, strip markdown emphasis chars (`*`, `_`, backtick, `~`), strip leading/trailing `…`/`...`/punctuation, collapse whitespace, trim
- [ ] 1.4 Replace the `findingKey()` implementation to use `sha1(severity | normalizeFile(file) | linebucket(line_start))` when `line_start` is present (> 0), and `sha1(severity | normalizeFile(file) | normalizeTitle(title))` as fallback

## 2. Tests

- [ ] 2.1 Update `core/test/review-policy.test.ts`: existing `findingKey` tests that assert specific hash values must be updated to reflect the new algorithm
- [ ] 2.2 Add stable-key property tests: finding with same severity + file + line_start (±4 lines within the same bucket) but different titles → same key
- [ ] 2.3 Add specificity tests: findings at different 5-line bands → different keys; findings at different severities → different keys; findings at different files → different keys
- [ ] 2.4 Add fallback tests: when `line_start` is absent, findings with different normalized titles → different keys; findings with the same normalized title (after markdown/capitalization normalization) → same key
- [ ] 2.5 Add the #144 regression test: a finding at file `f`, line `L`, severity `high`, title `T1` overridden in round N; in round N+1 the same finding is re-emitted at line `L+2` (same bucket) with title `T2` (reworded); `findingKey` returns the same 8-char hex for both → override still applies and `partitionFindings` does not count it as blocking

## 3. Recurrence Detection Consistency

- [ ] 3.1 Verify `review.ts` uses `findingKey()` (not an inline alternative) for both the punch-list RECURRING/NEW tagging and the early-park recurrence check — no code changes required if it does; update the call sites if they duplicate the old formula
- [ ] 3.2 Add a unit test: a finding re-emitted with a reworded title at the same location is tagged RECURRING (not NEW) by `buildRecurrenceMap`

## 4. Review Comment Display

- [ ] 4.1 Confirm that `formatReviewComment` in `review.ts` calls `findingKey(f)` to produce the displayed `override-key: <key>` — no code change needed if it does; the displayed key automatically reflects the new algorithm
- [ ] 4.2 Add a comment to `findingKey()` noting that in-flight `pipeline-override` sentinels recorded before this change carry old-algorithm keys and must be re-recorded; include the deploy date when this ships

## 5. Spec Sync

- [ ] 5.1 Run `openspec validate override-stable-finding-identity` and fix every structural error

## 6. CI

- [ ] 6.1 Run `npm run ci` from repo root; all tests must pass
