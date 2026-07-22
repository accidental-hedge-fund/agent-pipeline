## Why

`core/scripts/prompts/plan_revision.md` teaches the required acknowledgement format with a
**fenced** example whose first line is the section header itself:

```
## Feedback Incorporated
- [ADDRESSED] <brief description of what was changed>
```

Models copy the example verbatim, fence and all: they emit a bare `## Feedback Incorporated`
header, then a fenced block whose first line is a *second* `## Feedback Incorporated` header,
with every `[ADDRESSED]`/`[DEFERRED]` bullet inside the fence.

`verifyPlanRevisionOutput` (`core/scripts/verify-harness-commits.ts:287`) anchors on the
**first** header match, cuts the section at the next `^##` line — which is the duplicated
header *inside* the fence — and is left with a section containing only the opening fence
delimiter. It reports *"Plan revision ## Feedback Incorporated section has no [ADDRESSED] or
[DEFERRED] items"* and blocks, even though the model produced a fully correct, completely
tagged acknowledgement.

Observed on lyric-utils#658 (2026-07-20, engine claude, skill 1.15.1): the second attempt
produced 11 correctly tagged items that were invisible to the validator, burning two recovery
re-entries of a goal-loop run. Still reproducible in 1.15.2 (#443 comment, 2026-07-21) — the
prompt still ships the fenced example and the validator is unchanged. A local prompt hot-patch
unblocked the run but was overwritten by the next auto-update, so the fix must land upstream.

Both halves are needed: the prompt change stops the shape from being produced, and the
validator change stops a well-formed-but-fenced acknowledgement from ever being a false block —
the failure mode is an operator-visible hard block, so it must not depend on model compliance
with prompt wording alone.

## What Changes

- **Prompt (`plan_revision.md`)**: state the acknowledgement-section format as literal plain
  Markdown, not inside a code fence, and instruct explicitly that the section SHALL NOT be
  wrapped in a code fence and the header SHALL appear exactly once. The illustrative bullets
  must remain readable as an example without offering a fenced block to copy.
- **Validator (`verifyPlanRevisionOutput`)**: tolerate the fenced / duplicated-header shape.
  Code-fence delimiter lines are neutralised before section extraction, and *every* occurrence
  of the header is considered — tagged items found under any occurrence satisfy the gate.
- **Coverage warning**: the advisory feedback-coverage count is computed so a duplicated header
  does not double-count the same bullets.
- **Preserved negatives**: output with no acknowledgement section at all, and output whose
  section genuinely has no tagged items, SHALL still block with their existing reasons.
- Regression tests: the two observed lyric-utils#658 output shapes, plus a prompt output-contract
  test drift-guarding the "not fenced / header once" wording (mirroring the existing
  `prompt-loader.test.ts` guards for surgical-fix discipline).

## Capabilities

### New Capabilities

- `plan-revision-output-contract`: the wording contract the `plan_revision` prompt SHALL state
  about the acknowledgement section's format, drift-guarded by a test — the prompt-side half of
  the fix, with no home in an existing capability.

### Modified Capabilities

- `harness-step-verification`: the requirement "Plan-revision output includes machine-checkable
  feedback acknowledgement" gains an explicit tolerance contract for fenced and duplicated-header
  acknowledgement sections, while keeping its existing blocking scenarios intact.

## Impact

- `core/scripts/verify-harness-commits.ts` — `verifyPlanRevisionOutput` section extraction.
- `core/scripts/prompts/plan_revision.md` — acknowledgement-format wording.
- `core/test/verify-harness-commits.test.ts` — fenced/duplicated-header regression cases.
- `core/test/prompt-loader.test.ts` — prompt output-contract drift guard.
- `plugin/` mirror regenerated (`node scripts/build.mjs`).

## Acceptance criteria

- [ ] A plan-revision stdout consisting of a bare `## Feedback Incorporated` header followed by
      a fenced block whose first line repeats that header and whose body holds `[ADDRESSED]` /
      `[DEFERRED]` bullets is **accepted** by `verifyPlanRevisionOutput` (`ok: true`).
- [ ] A plan-revision stdout whose tagged bullets appear inside a code fence under a single,
      non-duplicated header is likewise accepted.
- [ ] Plan-revision stdout containing no `## Feedback Incorporated` header still blocks with
      `"Plan revision output is missing required ## Feedback Incorporated section"`.
- [ ] Plan-revision stdout containing the header but no `[ADDRESSED]`/`[DEFERRED]` items —
      fenced or not — still blocks with `"Plan revision ## Feedback Incorporated section has no
      [ADDRESSED] or [DEFERRED] items"`.
- [ ] When the same tagged bullets are reachable under more than one header occurrence, the
      advisory coverage warning counts them once (a 3-item acknowledgement duplicated across two
      headers does not report 6 tagged items).
- [ ] `core/scripts/prompts/plan_revision.md` no longer contains a fenced block whose content is
      a `## Feedback Incorporated` header, and the rendered prompt states both that the section
      must not be fenced and that the header must appear exactly once.
- [ ] A `prompt-loader.test.ts` case asserts that wording, so removing it fails the suite.
- [ ] `core/test/verify-harness-commits.test.ts` contains regression cases built from the two
      lyric-utils#658 output shapes (section omitted → blocks; fenced duplicated header with 11
      tagged items → accepted), and each bites: it fails against the pre-change validator.
- [ ] `npm run ci` passes from the repo root with the `plugin/` mirror in sync.
