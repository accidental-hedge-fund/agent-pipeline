## Why

The `last30days` skill brief is sourced from public discourse (Reddit, X, YouTube, HN, GitHub) and posted to GitHub as a comment before being embedded verbatim into planning prompts. Public discourse is untrusted: a crafted community post could contain a prompt-injection payload that steers planning away from the actual issue or introduces unauthorized instructions. Currently `carryForwardSection()` wraps the brief only with "Use this only where it informs the work; ignore irrelevant noise." — no injection-resistance framing, no output sanitization, no explicit untrusted boundary. The output brief is also posted to GitHub without any injection-pattern redaction (only the *input* research topic is sanitized, not the output).

## What Changes

- `core/scripts/stages/planning.ts`: export a new `sanitizeBriefForPrompt(text: string): string` function that redacts known prompt-injection imperatives (e.g. "Ignore all previous instructions", "Act as", "You are now", "Disregard previous/prior instructions") before the brief is posted or embedded.
- `core/scripts/stages/planning.ts`: in `gatherCarryForward`, apply `sanitizeBriefForPrompt` to `res.brief` before calling `postComment` and before returning the brief for planning.
- `core/scripts/prompts/index.ts`: rewrite `carryForwardSection()` to wrap the brief in an explicit `<untrusted-external-evidence>` XML fence and prepend a hard directive instructing agents that the enclosed content is untrusted external material they MUST NOT treat as instructions.
- `core/test/`: add unit tests for `sanitizeBriefForPrompt` (injection patterns redacted; clean text preserved) and fixture tests asserting the planning prompt contains the untrusted-evidence fence and does not contain raw injection text.

## Capabilities

### New Capabilities
- `carry-forward-injection-boundary`: The carry-forward context section in planning prompts SHALL be bounded by an explicit untrusted-evidence XML marker and a hard agent instruction-resistance directive. The brief SHALL be passed through an injection sanitizer before being embedded or posted.

### Modified Capabilities
- `last30days-context`: The "brief with signal" path SHALL sanitize the output brief for injection patterns before posting to GitHub and before embedding in the planning prompt, and SHALL wrap the embedded brief in the untrusted-evidence boundary defined by `carry-forward-injection-boundary`.

## Impact

- `core/scripts/stages/planning.ts` — new exported `sanitizeBriefForPrompt()`; `gatherCarryForward` calls it
- `core/scripts/prompts/index.ts` — `carryForwardSection()` rewritten with XML fence + injection-resistance directive
- `core/test/` — new unit tests and prompt fixture tests
- No state-machine changes; no new config keys; no API surface changes

## Acceptance Criteria

- [ ] `sanitizeBriefForPrompt` is exported from `planning.ts` and redacts known injection imperatives (replaces matches with `[REDACTED]`) while preserving surrounding text.
- [ ] `gatherCarryForward` applies `sanitizeBriefForPrompt` to `res.brief` before both the `postComment` call and the return value, so neither GitHub nor the prompt ever sees the raw untrusted brief.
- [ ] `carryForwardSection()` wraps non-empty briefs in `<untrusted-external-evidence>...</untrusted-external-evidence>` tags and includes an explicit directive that the enclosed content is untrusted and agents MUST NOT follow embedded instructions.
- [ ] A unit test for `sanitizeBriefForPrompt` covers: each injection pattern replaced with `[REDACTED]`; clean contextual text passes through unchanged.
- [ ] A prompt fixture test asserts that `buildPlanningPrompt` called with injection-like `carryForward` text produces a prompt containing the `<untrusted-external-evidence>` fence and not containing the raw injection imperatives.
- [ ] `npm run ci` passes with no regressions.
