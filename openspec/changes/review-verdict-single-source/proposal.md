## Why

The review verdict JSON schema is hand-copied verbatim into two prompt files (`review_standard.md`, `review_adversarial.md`) with no mechanism to detect when those copies drift from the `ReviewFinding`/`ReviewVerdict` types that `parseStructuredVerdict` actually reads. Schema drift is the root cause of silent finding loss (findings disappear → `needs-attention/0` → blocked runs), exactly the class of failure fixed in #45/#50/#52/#54 — this change closes the re-entry path permanently.

## What Changes

- Extract the review verdict JSON schema into a single source-of-truth constant (TypeScript object or JSON) co-located with `ReviewFinding`/`ReviewVerdict` in `core/scripts/types.ts` or a sibling `review-schema.ts`.
- Generate/embed the prompt schema block from that constant at build time (or via a lightweight template helper at runtime) so the prompt files no longer contain a hand-copied JSON block.
- Add a test that compares the fields declared in `ReviewFinding`/`ReviewVerdict` against the fields embedded in both review prompts and fails on any mismatch (field added, renamed, or removed on either side).
- No behavior change to the produced verdict shape, the review checklists, or any other prompt content.

## Capabilities

### New Capabilities

- `verdict-schema-single-source`: A single source of truth for the review verdict JSON schema that both the prompts and the TypeScript parser derive from, with a test that guards against drift.

### Modified Capabilities

- `review-layer`: The prompt-harness review prompts now embed a generated schema block rather than a hand-copied one; parser behavior is unchanged.

## Impact

- **Files changed**: `core/scripts/types.ts` (or new `core/scripts/review-schema.ts`), `core/scripts/prompts/review_standard.md`, `core/scripts/prompts/review_adversarial.md`, new test file (e.g., `core/scripts/review-schema.test.ts`).
- **No API or behavior change**: the emitted JSON shape is identical; `parseStructuredVerdict` is untouched.
- **CI**: new test must pass as part of `pnpm test`; a drift between types and prompts becomes a red CI build rather than a silent runtime failure.
