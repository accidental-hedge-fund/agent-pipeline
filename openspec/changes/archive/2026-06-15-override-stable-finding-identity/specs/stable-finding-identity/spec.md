## ADDED Requirements

### Requirement: Stable finding identity uses location when line_start is available
The pipeline SHALL derive a finding's stable key from its severity, normalized file path, and line bucket when `line_start` is present. The key SHALL be `sha1(severity | normalize(file) | line_bucket(line_start))` truncated to 8 hexadecimal characters. This key SHALL be identical for two findings that share the same severity, same file, and same 5-line band — regardless of how the reviewer phrases their titles.

`line_bucket(L)` SHALL equal `Math.floor((L - 1) / 5) * 5 + 1` for `L >= 1`. Lines 1–5 map to bucket 1; lines 6–10 map to bucket 6; and so on. `normalize(file)` SHALL lowercase the path string. When `line_start` is 0 or absent, the location-based path is not used; the fallback key is used instead.

#### Scenario: Same location, different titles — same key
- **WHEN** two findings share the same `severity`, the same `file`, and `line_start` values that fall in the same 5-line band (e.g. lines 43 and 46)
- **AND** the findings have different `title` values (including minor rewording or markdown formatting differences)
- **THEN** `findingKey` SHALL return the same 8-character hex string for both findings

#### Scenario: Different severities at same location — different keys
- **WHEN** two findings share the same `file` and the same `line_start` bucket
- **AND** their `severity` values differ
- **THEN** `findingKey` SHALL return different 8-character hex strings

#### Scenario: Same severity and title, different 5-line bands — different keys
- **WHEN** two findings share the same `severity`, `file`, and `title`
- **AND** their `line_start` values fall in different 5-line bands (e.g. lines 5 and 6)
- **THEN** `findingKey` SHALL return different 8-character hex strings

#### Scenario: Same severity and file, line drift within bucket — same key
- **WHEN** a finding at `line_start = 48` is re-emitted in a later round at `line_start = 50` (both in the 46–50 band)
- **AND** severity and file are unchanged
- **THEN** `findingKey` SHALL return the same 8-character hex string for both emissions

---

### Requirement: Stable finding identity falls back to normalized title when line_start is absent
When a finding does not carry a `line_start` (or `line_start` is 0), the pipeline SHALL derive the key from `sha1(severity | normalize(file) | normalize(title))`. `normalize(title)` SHALL: (1) lowercase the string, (2) remove markdown emphasis characters (`*`, `_`, backtick, `~`), (3) strip leading and trailing ellipsis characters (`…`, `...`) and punctuation, (4) collapse consecutive whitespace to a single space, and (5) trim the result.

#### Scenario: Absent line_start — falls back to normalized title
- **WHEN** a finding has no `line_start` (or `line_start` is 0)
- **AND** the finding has a non-empty `file` and `title`
- **THEN** `findingKey` SHALL use `sha1(severity | normalize(file) | normalize(title))` as the basis

#### Scenario: Normalized title absorbs markdown formatting
- **WHEN** two findings with absent `line_start` share the same `severity` and `file`
- **AND** their titles differ only in markdown emphasis (e.g. `"**can** starve"` vs `"can starve"`)
- **THEN** `findingKey` SHALL return the same 8-character hex string for both

#### Scenario: Normalized title preserves semantic differences
- **WHEN** two findings with absent `line_start` share the same `severity` and `file`
- **AND** their normalized titles differ after normalization (e.g. `"missing auth check"` vs `"slow loop"`)
- **THEN** `findingKey` SHALL return different 8-character hex strings

---

### Requirement: findingKey is the single source of identity for overrides and recurrence detection
The function `findingKey` in `review-policy.ts` SHALL be the one implementation of stable finding identity. Override matching (`partitionFindings`), recurrence detection (`extractBlockingKeysFromComment`, recurrence tagging), and review comment display SHALL all call this single function. No alternative or inline reimplementation of finding identity is permitted.

#### Scenario: Override matching uses findingKey
- **WHEN** `partitionFindings` checks whether a finding is overridden
- **THEN** it SHALL compare the finding's key computed by `findingKey(f)` against the keys stored in `pipeline-override` sentinels
- **AND** SHALL NOT reimplement the key derivation inline

#### Scenario: Recurrence detection uses findingKey
- **WHEN** the recurrence check compares current findings against prior review-comment keys
- **THEN** it SHALL use `findingKey(f)` to compute the current finding's key
- **AND** SHALL use the same 8-character keys embedded in prior comments (which were also computed by `findingKey`)
