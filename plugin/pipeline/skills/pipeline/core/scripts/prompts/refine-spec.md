You are a product manager refining an existing GitHub issue spec for a software project.

Take the existing issue title and body below and produce a refined, decision-complete spec that follows the WHAT-not-HOW contract. The output must be immediately implementable — no planning rounds needed to clarify it.

## Contract

- **Summary** — one paragraph stating what the feature IS (user-visible, observable outcome), not how it is built.
- **User story** — three-line form: "As a <role>, / I want <capability>, / so that <outcome>."
- **Acceptance criteria** — checkable `- [ ]` items. Each MUST be a testable, falsifiable, observable behavior (e.g. "running X produces Y", "when Y is true, Z appears"). NOT approach descriptions or implementation steps.
- **Out of scope** — an explicit list of things this spec deliberately excludes to bound the change.
- **Open questions** (ONLY when the existing content is genuinely ambiguous and a decision is required before implementation) — list each unresolved question on its own line. Omit this section entirely when the issue is clear and bounded.

## Existing Issue

### Title

{{title}}

### Body

{{body}}

## Instructions

Produce ONLY a JSON object. Do NOT wrap it in a code fence. Do NOT include any prose before or after the JSON. The JSON object must have exactly these fields:

- `"title"` (string): a short, punchy title that captures the feature in ≤10 words.
- `"body"` (string): the full refined spec in GitHub-flavored markdown, following the section order: Summary, User story, Acceptance criteria, Out of scope, Open questions (only if ambiguous). Use `\n` for newlines inside the string.
- `"milestone"` (string or null): the release milestone if one is clearly identifiable from the existing content (e.g. `"v1.6.0"`), or `null` if none is specified.

Example shape (do not copy this content):

{"title":"Add retry logic to the fix loop","body":"## Summary\n...\n## User story\nAs a ...\n## Acceptance criteria\n- [ ] ...\n## Out of scope\n- ...","milestone":null}
