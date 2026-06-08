## Context

The pipeline has two review stages (`review-1` standard and `review-2` adversarial) that already receive OpenSpec spec deltas via a helper called `openspecContext()`, defined privately in `review.ts`. The remaining harness-driven stages — plan-review, plan-revision, implementing, and fix — do not receive the spec deltas even when OpenSpec is active, so implementations and fixes can drift from the spec before review ever catches it.

The spec loading itself is already correct: `openspec.readSpecDeltas()` recursively reads all `.md` files under `openspec/changes/<name>/specs/` and returns them as a concatenated string. The gap is purely in wiring — the function isn't called at the right call sites, and the prompt templates have no placeholder for the content.

## Goals / Non-Goals

**Goals:**
- Extract `openspecContext()` from `review.ts` into `openspec.ts` so all stages share one implementation.
- Pass spec deltas into `buildPlanReviewPrompt`, `buildPlanRevisionPrompt`, `buildImplementingPrompt`, and `buildFixPrompt` when OpenSpec is active.
- Add a conditional `{{spec_context}}` section to the templates for those four steps.
- Leave non-OpenSpec runs completely unchanged (empty string → section not rendered).

**Non-Goals:**
- Changing review rounds — they already work correctly.
- Affecting docs-update, CI gate, mergeability gate, or pre-merge spec validate/archive steps.
- Changing what OpenSpec artifacts contain or how they are authored.
- Passing spec context to the planning (authoring) step — that step writes the spec, not consumes it.

## Decisions

**Extract `openspecContext()` to `openspec.ts`**

The function is three lines and its logic belongs in the module that owns all other OpenSpec reads. Keeping it in `review.ts` forces duplication at every new call site. Moving it to `openspec.ts` means any future stage can import it without pulling in review-stage dependencies.

Alternative considered: duplicate the three lines at each call site. Rejected — trivial duplication that invites drift.

**Optional `specContext?: string` parameter on prompt builders**

Adding an optional parameter (defaulting to `""`) is the least-invasive change: existing callers don't need to change, and the template section renders only when the value is non-empty.

Alternative considered: a global "pipeline context" object passed to all builders. Rejected — over-engineering for a focused change; adds indirection without benefit here.

**Conditional section in templates**

The template renderer already supports `{{#if spec_context}}…{{/if}}`-style conditionals (or equivalent empty-string elision). The spec context block renders only when the value is non-empty, so non-OpenSpec prompts are byte-for-byte identical to today.

**Implementing step: spec deltas in addition to proposal + tasks**

The OpenSpec implementing path currently passes `proposal.md` + `tasks.md` to the implementer. Spec deltas are the requirements the tasks are meant to satisfy. Including them alongside the tasks gives the implementer the full intent picture without removing the actionable task list.

## Risks / Trade-offs

**Prompt length increase** → Spec deltas are typically a few hundred lines at most for focused changes. The model context windows in use (100k+) absorb this easily. If a repo has unusually large spec deltas, the existing `readSpecDeltas()` cap (file-based) applies.

**Spec deltas not yet written when plan-review runs** → In the OpenSpec planning flow, spec deltas are authored during the planning stage, so by the time plan-review runs they exist. In the freeform planning flow, OpenSpec is not active and `openspecContext()` returns `""` — no change.

**Multi-change repos** → `openspecContext()` takes `changes[0]`; this is the existing convention used by review. Keeping the same convention is consistent and non-breaking.
