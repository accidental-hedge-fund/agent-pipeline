## Why

Audited `--override` dispositions are content-addressed by a finding key derived from `sha1(severity|file|title)`, but the reviewer rewrites finding titles across review rounds. A single-word insertion ("can" → "can still") mints a new key, so a recorded override silently stops applying and the item re-parks at `needs-human`. As long as the reviewer re-emits the same underlying issue under a slightly different title, the override path cannot converge — a human's recorded decision has no effect. This was observed directly in #19 across five consecutive review rounds.

## What Changes

- **`findingKey` algorithm** (`review-policy.ts`) — replace `sha1(severity|file|title)` with a shift-tolerant key: `sha1(severity | normalize(file) | line_bucket(line_start))`. When `line_start` is absent, fall back to `sha1(severity | normalize(file) | normalize(title))`. The new key is stable under any title rewording when the finding's location (file + approximate line) and severity are the same.
- **`review-loop-recurrence` recurrence detection** — update `findingKey` usage so that a finding re-emitted with the same location+severity but a reworded title is correctly classified as RECURRING, not NEW. Consistent identity means the same physical issue is recognized across rounds regardless of title drift.
- **Finding display in review comments** — continue to show the full human-readable title next to the key; the displayed key changes to the new algorithm (existing in-flight overrides must be re-recorded after deploy).
- **Migration note** — any `pipeline-override` sentinels recorded before this change carry old-algorithm keys. They will cease to apply after deployment. This is a one-time migration cost; new overrides will be durable.

## Capabilities

### New Capabilities

- `stable-finding-identity`: The shift-tolerant algorithm for deriving a finding's stable key. Defines normalization rules (`normalize(file)`, `line_bucket(line_start)`, `normalize(title)`) and the fallback logic when `line_start` is absent.

### Modified Capabilities

- `review-severity-policy`: The "Audited operator overrides" requirement currently mandates that the key is "content-addressed (severity, file, title)". This must be updated to reflect the new location-based primary key and title-based fallback.
- `review-loop-recurrence`: The requirement "A finding whose severity or title changes carries a different `findingKey` and SHALL be treated as a new finding" must be updated: a title change alone no longer produces a new key; only a severity or file/location change does.

## Acceptance Criteria

- [ ] A recorded `--override` continues to apply across review rounds when the reviewer rewords the finding title, provided the finding's file, line location (within the same 5-line band), and severity are unchanged. A drift that crosses a band boundary produces a different key and the override does not carry over.
- [ ] The finding identity key is stable under all title rewording — derived from severity + normalize(file) + line_bucket(line_start) when `line_start` is available.
- [ ] Two findings at different severities, or different files, or different 5-line bands, produce different keys even if their titles are identical (adequate specificity).
- [ ] Recurrence detection (#133 RECURRING/NEW tagging) uses the same stable key: a finding re-emitted with a reworded title but same location+severity is tagged RECURRING, not NEW.
- [ ] Existing audited-override behavior (sentinel comment, `partitionFindings`, override-auto-resume) is preserved; only the key derivation changes.
- [ ] A regression test: finding overridden in round N, re-emitted in round N+1 with a reworded title AND a ±2-line shift, stays dispositioned and the item advances instead of re-parking.
- [ ] `npm run ci` passes with the new key algorithm; the `findingKey` test suite is updated to cover the stable-key properties.

## Impact

- `core/scripts/review-policy.ts` — `findingKey()` function (algorithm change)
- `core/scripts/stages/review.ts` — all callers of `findingKey()` pick up the change automatically
- `core/test/review-policy.test.ts` — extend tests to cover the new stable-key properties and the title-drift regression scenario
- Review comments — the 8-hex key displayed next to each finding changes value; any in-flight `pipeline-override` sentinels keyed by the old algorithm are invalidated at deploy time and must be re-recorded
