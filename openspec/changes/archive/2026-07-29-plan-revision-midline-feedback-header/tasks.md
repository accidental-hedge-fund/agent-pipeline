## 1. Pin the failure shape

- [x] 1.1 Reconstruct the #622 / #658 plan-revision stdout fixture: preamble glued to
      `## Feedback Incorporated` on the same line, followed by multiple line-start
      `[ADDRESSED]` bullets (and optional full revised plan body).
- [x] 1.2 Add the fixture to `core/test/verify-harness-commits.test.ts` (or
      `planning-impl.test.ts` for stage-level cases) and confirm it currently fails against
      the unchanged `verifyPlanRevisionOutput` — the test must bite.

## 2. Validator mid-line tolerance

- [x] 2.1 In `core/scripts/verify-harness-commits.ts`, normalise mid-line /
      preamble-glued `## Feedback Incorporated` headers to line-start before the existing
      multi-header extraction (after or alongside fence-delimiter neutralisation).
- [x] 2.2 Keep fence/bold/case/duplicated-header behaviour and both existing block reason
      strings unchanged for true negatives.
- [x] 2.3 Unit tests: mid-line header + tagged items → `ok: true`; mid-line header with no
      tagged items → no-items failure; truly absent section → missing-section failure;
      existing fenced/emphasis/coverage cases still pass; prose `[ADDRESSED]` outside a
      section still fails.

## 3. Bounded format-repair retry in planning

- [x] 3.1 In the shared planning phase path (`core/scripts/stages/planning.ts` /
      `runPlanningPhases`), when `verifyPlanRevisionOutput` fails after a successful
      plan-revision harness exit, perform at least one automatic re-prompt with a short
      format-repair addendum (line-start header + tagged bullets) instead of immediately
      `setBlocked(..., "needs-human")`.
- [x] 3.2 On repair success, continue the normal post-revision path (revalidate, human-
      feedback ack, post revised plan, advance).
- [x] 3.3 On budget exhaustion, block without posting the revised plan; terminal disposition
      remains `needs-human` with the existing reason strings where applicable.
- [x] 3.4 Preserve freeform / OpenSpec paired blocker equivalence for this failure mode.
- [x] 3.5 Stage-level tests with injected harness fakes: (a) first stdout mid-line but valid
      after normalisation → no retry needed, proceeds; (b) first stdout truly missing section,
      second stdout compliant → proceeds after one retry; (c) both attempts non-compliant →
      blocked `needs-human`, revised plan not posted.

## 4. Prompt contract

- [x] 4.1 Update `core/scripts/prompts/plan_revision.md` so the acknowledgement-format
      instructions require the header at **line start** (in addition to unfenced + exactly
      once).
- [x] 4.2 Extend `core/test/prompt-loader.test.ts` drift guard for the line-start wording.

## 5. Ship

- [x] 5.1 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change
      when `core/` is edited.
- [x] 5.2 `npm run ci` from the repo root — green, including `openspec validate --all`.
