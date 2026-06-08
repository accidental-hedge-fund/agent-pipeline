## Context

`gatherCarryForward` in `core/scripts/stages/planning.ts` calls `last30days.run(title, ...)`. Both call sites already have `body` in scope from `getIssueDetail` — it just is not passed:
- Freeform flow (line ~59): `const body = detail.body`
- OpenSpec flow (line ~301): `const { title, body } = detail`

The skill's `topic` parameter is a plain-text query string. Passing the raw body verbatim risks noise (long markdown tables, code blocks, HR lines) and an unbounded input length, so topic construction needs a length cap.

## Goals / Non-Goals

**Goals:**
- Make the research topic reflect the issue's full content (title + description) when a description is present.
- Keep the topic bounded: no unbounded body pass-through to the skill.
- Preserve existing behavior exactly when the body is empty or `last30days` is disabled.
- Keep `gatherCarryForward` and `buildResearchTopic` independently unit-testable.

**Non-Goals:**
- LLM-based summarization of the body (adds latency and cost to a non-blocking opt-in step).
- Using issue comments, linked PRs, or any source other than this issue's title + body.
- Changing the brief's placement, format, or downstream injection into the planning prompt.
- Modifying `last30days.run()`, `hasSignal()`, or `BriefResult`.
- Making the threshold user-configurable in `pipeline.yml` (not yet needed).

## Decisions

### D1 — Heuristic truncation, not LLM summarization

For bodies ≤ 400 characters, append verbatim. For longer bodies, truncate at 400 characters at the nearest word boundary and append `…`.

The skill already filters and clusters content from 6+ sources; it does not need a semantically perfect topic — a focused excerpt outperforms a title alone. LLM summarization would add an async dependency, possible cost, and a new failure mode to a step that is already non-blocking and optional.

_Alternatives:_ Extract first N sentences — fragile for structured/markdown bodies. Use raw body verbatim — rejected; unbounded input with noise (code blocks, tables).

### D2 — `buildResearchTopic` is a separate, pure, exported helper

Extracting topic-building into a named function makes it unit-testable in isolation (no skill invocation needed), and keeps `gatherCarryForward` focused on orchestration. The helper is pure: no I/O, no side effects.

_Alternatives:_ Inline the logic — rejected; the branching and truncation warrants dedicated tests.

### D3 — `body?` is an optional parameter on `gatherCarryForward`

Adding `body?: string` before `deps` maintains backwards compatibility with all existing tests and any caller that passes `(cfg, issueNumber, title)`. An absent or empty body falls back to title-only, matching today's behavior.

_Alternatives:_ New function name — rejected (unnecessary churn, breaks callers); pass the full `detail` object — rejected (over-widening; only `title` and `body` are relevant).

### D4 — 400-character threshold

400 chars fits a detailed one-to-two-sentence description verbatim, is comfortably within any downstream token budget, and is enough context for the skill to produce focused queries. The exact value is an implementation detail not exposed to users.

_Alternatives:_ 500 chars — reasonable; difference is marginal and implementer may adjust.

## Risks / Trade-offs

- **Truncation loses tail content**: If the most specific context appears late in a long description, the first-400-chars cut may miss it. Mitigation: this is best-effort enrichment; the full body still reaches the planning prompt unchanged via `buildPlanningPrompt`.
- **Noisy topic for structured bodies**: A description with large code blocks or tables at the top produces a noisier topic than prose. Mitigation: the skill normalizes and clusters its own sources; a slightly noisy topic is better than a title-only query.
- **Threshold staleness**: The cap is not user-configurable. If issues in practice need more, a one-line PR change to the constant is low-effort.
