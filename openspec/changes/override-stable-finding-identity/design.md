## Context

`findingKey()` in `review-policy.ts` computes an 8-character hex key that labels each review finding in comments and is the lookup key when the pipeline checks whether an operator has recorded an override via `--override "<key>: <reason>"`. The same key is used by `review-loop-recurrence` to identify recurring findings across rounds.

Current implementation:
```ts
const basis = `${f.severity ?? "medium"}|${f.file ?? ""}|${f.title ?? ""}`;
return createHash("sha1").update(basis).digest("hex").slice(0, 8);
```

Because `title` is in the basis, any wording change — including adding/removing a single word or stripping markdown formatting — changes the key. A recorded override stops applying silently.

## Goals / Non-Goals

**Goals:**
- Stable key under title rewording: same file + same 5-line band + same severity → same key, regardless of how the reviewer phrases the finding.
- Adequate specificity: two genuinely different issues at the same location are distinguished by severity or, when `line_start` is absent, by their normalized title.
- Consistent identity for both override matching and recurrence detection; no divergence between what counts as "the same finding" for overrides vs. for RECURRING/NEW tagging.

**Non-Goals:**
- Backward-compatible key migration: in-flight overrides recorded before this change will have old-algorithm keys and must be re-recorded. One-time cost; acceptable.
- Fuzzy/semantic title similarity (Levenshtein, Jaccard): the implementation cost and indeterminism outweigh the marginal gain given the location-based primary key.
- Changing what severities block (that is `review_policy`).

## Decisions

### D1: Primary key is location-based, not title-based

**Decision**: When `line_start` is present, the stable key is `sha1(severity | normalize(file) | line_bucket(line_start))`. Title is excluded from the primary key.

**Rationale**: The only reliable indicator that two findings across rounds represent "the same issue" is that they appear at the same location in the same file with the same severity. Title is the reviewer's natural-language description of that issue; the reviewer is free to rephrase it without changing the underlying defect. Including title in the primary key couples the override's durability to the reviewer's phrasing choices — the exact failure mode observed in #19.

**Specificity**: Two different issues at the same file + 5-line band + severity map to the same key. In practice, a code reviewer almost never flags two separate blocking issues of the same severity at the same location (a 5-line band is narrow). When it does occur, overriding one overrides both — which is documented behavior. This is a conservative trade-off: the operator may inadvertently disposition both findings, but this is far less harmful than the current behavior where a valid override stops applying every time the reviewer rewords the title.

**Alternative considered**: fuzzy title matching (Levenshtein ≥ 0.7 or Jaccard of word tokens ≥ 0.75). Rejected because: (a) the #19 title change drops most of the leading context phrase, making similarity scores low regardless of threshold; (b) similarity functions introduce non-deterministic edge cases and are hard to test; (c) location-based identity is conceptually cleaner and covers all title-rewording scenarios with a single rule.

**Alternative considered**: `severity | normalize(file) | normalize(title)` (normalize-only, no location). Rejected because `normalize()` absorbs markdown formatting and capitalization but not word insertion — "can starve" vs "can still starve" differ even after normalization. This approach would not fix the #19 root cause.

### D2: `line_bucket(line_start, size=5)`

**Decision**: `line_bucket(L) = Math.floor((L - 1) / 5) * 5 + 1` for `L >= 1`. Lines 1–5 → bucket 1; lines 6–10 → bucket 6; etc. When `line_start` is absent or 0, treat `line_bucket` as 0 (triggers the title-based fallback path).

**Rationale**: A 5-line band is narrow enough to avoid collapsing findings across distinct code constructs, while wide enough to absorb the ±1–2 line drift typical when a fix round edits the surrounding code (a surrounding method signature changes, an import is added, etc.). The ±4 lines covered within one bucket is the practical upper bound for stable findings in a code review context.

**Why not ±3 window centered on `line_start`**: Centering on `line_start` gives a moving window that is not reproducible from the stored key alone (you cannot reconstruct the center from a stored bucket). Fixed-partition bands are deterministic: the bucket is a pure function of the line number, with no reference to where the override was originally recorded.

### D3: Fallback when `line_start` is absent

**Decision**: `sha1(severity | normalize(file) | normalize(title))` where:
- `normalize(file)`: lowercase
- `normalize(title)`: lowercase, remove markdown emphasis characters (`*`, `_`, backticks, `~`), strip leading/trailing punctuation and ellipsis (`…`, `...`), collapse whitespace, trim

**Rationale**: When the reviewer does not emit a line number (some findings are file-level), location-based keying is impossible. Title normalization absorbs the most common phrasing drift (markdown emphasis, capitalization, trailing punctuation). This is not as stable as the location-based key, but significantly more stable than the raw title.

### D4: Recurrence detection uses the same key

**Decision**: `review-loop-recurrence` already uses `findingKey()` for RECURRING/NEW tagging. Since we change `findingKey()`, recurrence tagging automatically picks up the same stability improvements. No separate identity function is introduced; there is exactly one `findingKey` implementation.

**Consequence**: A finding re-emitted with a reworded title at the same location is now tagged RECURRING (not NEW). This is more accurate: the underlying issue did recur; the reviewer merely described it differently. This removes one source of misleading NEW tags in the punch-list.

### D5: Display key = stable key

**Decision**: The 8-hex key shown to the operator in the review comment (`override-key: <key>`) is the same value used for override matching. There is no separate "display key".

**Rationale**: A dual-key scheme (display key for operators, stable key for matching) would require operators to record overrides using a key that does not match what is displayed — a usability failure. Single key keeps the display and the lookup consistent.

### D6: In-flight overrides are invalidated at deploy time

**Decision**: Existing `pipeline-override` sentinels carry keys from the old algorithm. After this change ships, those keys will no longer match any finding's new stable key. Operators must re-record any in-flight overrides.

**Rationale**: A migration shim that accepts both old and new keys would permanently couple the codebase to the old algorithm and add complexity to `partitionFindings`. The number of active in-flight overrides at any moment is small (a handful of issues per repo); the one-time re-record cost is negligible.

## Risks / Trade-offs

- **Same-location same-severity collapse**: two genuinely distinct issues at the same 5-line band + severity share a key. The operator overriding one dispositions both. Mitigated by rarity and documentation.
- **Line-number drift beyond bucket size**: a finding that shifts by ≥5 lines (e.g., after a large refactor) falls into a new bucket and loses its override. Mitigated by the 5-line band being wide enough for typical fix-round edits; large refactors that shift findings significantly usually change the code enough that the finding legitimately needs re-evaluation.
- **Key invalidation at deploy**: active overrides must be re-recorded. Mitigated by the small number of active overrides in practice and the one-time nature of the migration.
