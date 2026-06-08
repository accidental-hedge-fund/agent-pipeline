## Why

The pre-planning last30days brief currently runs against the issue **title only**. Issues often have terse titles but detailed descriptions, so a title-only query returns weak or irrelevant signal even when the body holds rich context — producing a carry-forward brief that does not reflect what the issue is actually asking for.

## What Changes

- Add a `buildResearchTopic(title, body?)` helper to `core/scripts/stages/planning.ts` that builds the research input for the last30days skill from the issue's full content (title + description).
  - When `body` is empty or whitespace-only: returns `title` unchanged (no regression vs. today).
  - When `body` is short (≤ threshold): appends the body verbatim to the title.
  - When `body` is long (> threshold): appends a truncated, bounded excerpt of the body (trimmed at a word boundary with a `…` marker) so the topic stays focused and noise-free.
- Update `gatherCarryForward` to accept an optional `body?` parameter and pass `buildResearchTopic(title, body)` as the topic to `last30days.run()` instead of `title` alone.
- Update both call sites in `planning.ts` (freeform flow line ~72; OpenSpec flow line ~317) — `body` is already in scope at both sites from `getIssueDetail`.
- Unit tests: topic-from-title-only, topic-from-short-body, topic-from-long-body-bounded, topic-from-whitespace-body, and `gatherCarryForward` integration variants (body present vs. absent).
- No change to the brief's placement, format, posted comment, or downstream injection into the planning prompt.

## Capabilities

### New Capabilities

- `last30days-full-issue-topic`: The research topic passed to the last30days skill SHALL be derived from the issue's full content (title + description), bounded at a character threshold for long descriptions, with a title-only fallback when the description is absent.

### Modified Capabilities

<!-- none — no existing spec-level requirement is changing; the `last30days-setup-hint` and overall non-blocking/opt-in contract are unaffected -->

## Impact

- **`core/scripts/stages/planning.ts`** — `gatherCarryForward`: new optional `body?` parameter; new `buildResearchTopic` exported helper; both call sites updated to pass `body`.
- **`core/scripts/last30days.ts`** — read-only (no signature or behavioral changes).
- **Test files** — new unit tests for `buildResearchTopic` and for `gatherCarryForward` with/without body.
- **No change to `last30days.run()`, `hasSignal()`, `BriefResult`, the comment format, or any other module.**
