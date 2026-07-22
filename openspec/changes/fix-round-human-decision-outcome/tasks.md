## 1. Blocker taxonomy

- [ ] 1.1 Add `"human-decision-required"` to `BLOCKER_KINDS` in `core/scripts/types.ts`.
- [ ] 1.2 Add its `BLOCKER_RECIPES` entry naming the existing `--unblock` / `--override` verbs
      (a missing recipe fails `blocked-recipes.test.ts`).
- [ ] 1.3 Map it to `"product-judgment-required"` in `blockerKindToInterventionKind`
      (`core/scripts/intervention.ts`); add no new `HumanInterventionKind` member.
- [ ] 1.4 Test: the new kind emits `human_intervention` `kind: "product-judgment-required"`, and
      the taxonomy member set is unchanged.

## 2. Declaration grammar (prompt)

- [ ] 2.1 Add the `## Needs-Human-Decision Outcome` section to `core/scripts/prompts/fix.md`:
      the single-line declaration format, the closed category set, the requirement to copy
      `finding-fingerprint` verbatim and use `{{reviewed_sha}}`, and the explicit statement that
      this outcome resolves nothing and advances nothing.
- [ ] 2.2 State the boundary against the does-not-reproduce outcome in the same section.
- [ ] 2.3 Add the drift guard in `core/test/prompt-loader.test.ts` (mirrors the existing
      surgical-fix / does-not-reproduce guards).

## 3. Parser

- [ ] 3.1 Add `HumanDecisionDeclaration` type and the anchored full-line global regex in
      `core/scripts/stages/fix.ts`, with the category as a literal alternation and ` | ` before
      the decision request.
- [ ] 3.2 Export `parseHumanDecisionDeclarations(stdout)` — pure text scan, `[]` on absent or
      malformed input.
- [ ] 3.3 Unit tests: absent, malformed, multi-line, unknown category, valid single, valid
      multiple.

## 4. Acceptance and park decision

- [ ] 4.1 Export `decideHumanDecisionPark(renderedIdentities, declarations, currentHead)`
      returning the accepted declarations; accept only on `(key, fingerprint)` identity match,
      `reviewedSha === currentHead`, and a non-empty decision request.
- [ ] 4.2 Unit tests: unmatched identity, stale SHA, empty request, and the accepting case.

## 5. Evidence comment

- [ ] 5.1 Add `humanDecisionComment(...)` to `core/scripts/review-policy.ts` — heading
      `## Pipeline: Human decision required`, sentinel `<!-- pipeline-human-decision: ... -->`,
      wrapped in `attestPipelineComment`; carries category, decision request, key, fingerprint,
      reviewed SHA, stage, timestamp, footer.
- [ ] 5.2 Confirm nothing reads the sentinel back to suppress a finding (no extractor added).
- [ ] 5.3 Snapshot/unit test of the rendered comment and its distinctness from the override and
      non-reproducing sentinels.

## 6. Wire into the no-commit path

- [ ] 6.1 In `advanceFix`, on the `!salvaged` / non-external branch, evaluate the park decision
      **before** `decideDoesNotReproduceAdvance`.
- [ ] 6.2 On accept: post one evidence comment per accepted declaration, then
      `setBlocked(..., "human-decision-required")` with a reason naming the categories and
      requests; return `{ advanced: false, status: "blocked", blockerKind:
      "human-decision-required" }`. No transition.
- [ ] 6.3 On no accept: fall through unchanged to the does-not-reproduce decision and then the
      existing `no-commits` block.

## 7. Regression suite

- [ ] 7.1 Valid `product-decision` park: blocks with the new kind, posts evidence, no transition,
      no override/disposition recorded.
- [ ] 7.2 One test per category (`product-decision`, `authority`, `external-dependency`).
- [ ] 7.3 Malformed declaration → `no-commits`.
- [ ] 7.4 Missing/empty decision request → `no-commits`.
- [ ] 7.5 Stale reviewed SHA → `no-commits`.
- [ ] 7.6 Unmatched `(key, fingerprint)` → `no-commits`.
- [ ] 7.7 Mixed human-decision + does-not-reproduce round → parks, does not advance.
- [ ] 7.8 Pure does-not-reproduce round → still advances `fix-1`→`review-2` and
      `fix-2`→`pre-merge` (#391 preserved).
- [ ] 7.9 Confirm each new test bites: it fails against the pre-change fix stage.

## 8. Ship

- [ ] 8.1 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 8.2 `openspec validate fix-round-human-decision-outcome` and `openspec validate --all`.
- [ ] 8.3 `npm run ci` green from the repo root.
