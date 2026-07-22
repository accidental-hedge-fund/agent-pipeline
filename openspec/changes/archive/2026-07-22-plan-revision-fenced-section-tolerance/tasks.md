## 1. Pin the failure shape

- [x] 1.1 Reconstruct the two lyric-utils#658 plan-revision outputs as test fixtures: (a) no
      acknowledgement section at all, (b) bare header + fenced block repeating the header with
      11 tagged bullets inside.
- [x] 1.2 Add both to `core/test/verify-harness-commits.test.ts` and confirm (b) currently
      fails against the unchanged `verifyPlanRevisionOutput` — the test must bite.

## 2. Validator tolerance

- [x] 2.1 In `core/scripts/verify-harness-commits.ts`, neutralise code-fence delimiter lines
      (``` ``` ```/`~~~`) before section extraction in `verifyPlanRevisionOutput`, keeping fenced
      content in place.
- [x] 2.2 Scan every `## Feedback Incorporated` header occurrence, building one candidate
      section per occurrence (header → next `^##`); pass when any section holds a line-anchored
      tagged item.
- [x] 2.3 Compute the advisory coverage count as the max tagged-item count over candidate
      sections so a duplicated header does not double-count.
- [x] 2.4 Keep both existing block reasons and their exact strings unchanged.

## 3. Validator tests

- [x] 3.1 Fenced + duplicated header → accepted; fenced under a single header → accepted.
- [x] 3.2 Missing header → blocks with the existing missing-section reason.
- [x] 3.3 Header present, no tagged items (fenced and unfenced variants) → blocks with the
      existing no-items reason.
- [x] 3.4 Prose mention of `[ADDRESSED]` outside any section does not satisfy the gate.
- [x] 3.5 Duplicated three-item acknowledgement reports a coverage count of three.
- [x] 3.6 Existing `verifyPlanRevisionOutput` cases (emphasis-wrapped tags, advisory coverage
      warning) still pass untouched.

## 4. Prompt contract

- [x] 4.1 Rewrite the acknowledgement-format instruction in
      `core/scripts/prompts/plan_revision.md`: remove the fenced example, show the tag shape as
      plain Markdown, and state explicitly that the section must not be fenced and the header
      must appear exactly once.
- [x] 4.2 Add a `core/test/prompt-loader.test.ts` case asserting that wording and asserting no
      fenced block in the template contains a `## Feedback Incorporated` header — matching the
      existing surgical-fix-discipline drift guards.

## 5. Ship

- [x] 5.1 Regenerate the mirror: `node scripts/build.mjs`; commit `plugin/` in the same change.
- [x] 5.2 `npm run ci` from the repo root — green, including `openspec validate --all`.
