## Why

With `harnesses.implementer: grok` (Codex as reviewer), plan-review can return
`NEEDS_REVISION`, the implementer can produce a complete revision with a
`## Feedback Incorporated` section and many `[ADDRESSED]` items, and the pipeline
still **hard-blocks** with `Plan revision output is missing required ## Feedback
Incorporated section`. The observed failure is a **format-contract false negative**:
the header is present but glued mid-line after preamble text
(`…required changes.## Feedback Incorporated`), so the line-anchored header
regex in `verifyPlanRevisionOutput` misses it. The stage then calls
`setBlocked(..., "needs-human")` with no automatic format retry.

For a product whose goal is a fully autonomous agentic lifecycle, operator
babysitting of a semantically correct acknowledgement is a pipeline bug, not an
acceptable cross-harness quirk. Related contract hardening already exists
(#68, fenced/duplicated-header tolerance from #443 / plan-revision-fenced-section-tolerance);
this is the same class of model messiness.

## What Changes

- **Validator (`verifyPlanRevisionOutput`)**: accept a mid-line / preamble-glued
  `## Feedback Incorporated` header when it is followed by at least one
  line-start `[ADDRESSED]` / `[DEFERRED]` item. Normalize before matching (or
  otherwise accept equivalent forms) so the gate no longer reports the section
  as missing for the observed Grok shape.
- **Disposition on pure output-contract failure**: when the acknowledgement
  section is still missing or malformed after normalization, treat the failure
  as a **retryable harness format failure** — at least one automatic
  re-prompt/retry with a short format-repair instruction — rather than
  immediately parking the issue as `needs-human`.
- **Exhausted retries**: after the bounded format-retry budget is spent without
  a compliant acknowledgement, the stage still blocks (terminal for the
  advance attempt). Prefer keeping the existing `needs-human` tag for exhausted
  cases so operators get a clear human remediation path; do **not** invent a
  new `harness-format-failure` blocker class in this change.
- **Preserved positives and negatives**: existing fence/bold/case tolerances
  remain; truly absent section or header-with-no-tagged-items still fails;
  Claude primary + Codex secondary plan-revision path stays green.
- **Tests**: regression cases for mid-line header + tagged items → ok; truly
  absent section still fails after the retry policy is applied; existing
  tolerance cases remain.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `harness-step-verification`: extend the plan-revision acknowledgement gate
  with mid-line / preamble-glued header tolerance, and change pure
  output-contract failures from immediate `needs-human` to a bounded
  format-repair retry before a terminal block.
- `plan-revision-output-contract`: strengthen the prompt contract so the
  acknowledgement header is required to appear as a **line-start** Markdown
  heading (not only “exactly once” and unfenced), while remaining
  drift-guarded by tests.

## Impact

- `core/scripts/verify-harness-commits.ts` — `verifyPlanRevisionOutput` header
  detection / normalization.
- `core/scripts/stages/planning.ts` — plan-revision ack-failure disposition and
  bounded format-repair retry (both freeform and OpenSpec paths via the shared
  planning phase runner).
- `core/scripts/prompts/plan_revision.md` — line-start header wording (prompt
  half of defence in depth).
- `core/test/verify-harness-commits.test.ts` / `core/test/planning-impl.test.ts`
  — mid-line acceptance + retry/disposition regression cases.
- `core/test/prompt-loader.test.ts` — prompt output-contract drift guard for
  line-start wording.
- `plugin/` mirror regenerated if `core/` changes (`node scripts/build.mjs`).

Out of scope: plan-review verdict schema, `review_policy` thresholds, #622
product work (worktree reclaim safety), broader multi-harness eval matrix
beyond the plan-revision ack contract, and a new blocker-kind taxonomy.

## Acceptance criteria

- [ ] Plan-revision stdout with a mid-line or preamble-glued
      `## Feedback Incorporated` header followed by at least one line-start
      `[ADDRESSED]` / `[DEFERRED]` item is **accepted** by
      `verifyPlanRevisionOutput` (`ok: true`) — the gate does **not** report the
      section as missing.
- [ ] A pure plan-revision **output-contract** failure (missing or malformed ack
      section after normalization) triggers **at least one automatic
      format-repair re-prompt/retry** rather than an immediate `needs-human`
      block.
- [ ] When the format-retry budget is exhausted without a compliant section, the
      stage blocks and does **not** post the revised plan; Claude primary + Codex
      secondary plan-revision remains green (no regression on well-formed
      line-start sections).
- [ ] Existing fence, bold/emphasis-wrapped tag, case, and duplicated-header
      tolerances still pass; prose mentions of `[ADDRESSED]` outside a section
      still do not satisfy the gate; header present with zero tagged items still
      fails with the existing no-items reason.
- [ ] Unit/regression tests cover mid-line header + tagged items → ok, and a
      truly absent section that fails after the retry policy; tests bite against
      the pre-change behavior.
- [ ] `npm run ci` is green from the repo root; `plugin/` is regenerated in the
      same change when `core/` is edited.
