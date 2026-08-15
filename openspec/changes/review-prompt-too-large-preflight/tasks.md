## 1. Blocker kind and recipe

- [ ] 1.1 Add `review-prompt-too-large` to `BLOCKER_KINDS` and a non-empty `BLOCKER_RECIPES` entry that states the prompt exceeded the reviewer ceiling and that re-running without reducing the payload or changing the reviewer/ceiling will fail again (no “re-run as-is” / transient-timeout guidance).
- [ ] 1.2 Extend blocked-recipe exhaustiveness / snapshot tests so a missing or emptied recipe for the new kind fails.
- [ ] 1.3 Extend any closed maps that require every `BlockerKind` (stage-diagnostic projection, intervention kind mapping, scoreboard lists) so the new kind compiles and is classified as non-retry-same-payload mechanical block, not generic `harness-failure` transient retry.

## 2. Ceiling resolution and preflight helper

- [ ] 2.1 Implement a pure helper that resolves the effective character ceiling: configured reviewer’s finite declared max when present, else `1_048_576`.
- [ ] 2.2 Implement a pure check: given assembled prompt text + ceiling → `{ ok: true } | { ok: false, measured, ceiling }` using character length of the fully assembled string.
- [ ] 2.3 Unit-test the helper: over ceiling → not ok with measured/ceiling; at/under ceiling → ok; missing finite declaration → ceiling `1048576`.

## 3. Wire review-1 and review-2 before harness spawn

- [ ] 3.1 In the shared review invoke path (post-`buildReview*Prompt` and same-path appendages, before stage-executor / ensemble / `invokeReviewer` spawn), run the preflight on the assembled prompt.
- [ ] 3.2 On oversize: call `setBlocked` with kind `review-prompt-too-large`, return blocked outcome with that `blockerKind` and a reason that includes measured size and ceiling; do not call harness invoker seams.
- [ ] 3.3 On under-ceiling: leave existing invoke path unchanged.
- [ ] 3.4 Unit tests with injected deps: oversize `review-1` and oversize `review-2` → zero harness spawns, correct kind; under-ceiling → harness invoked once (or existing ensemble behavior).

## 4. Auto-loop non-recoverability

- [ ] 4.1 Update `isAutoLoopRecoverable` so `blockerKind: "review-prompt-too-large"` returns false.
- [ ] 4.2 Unit test: blocked outcome with that kind is not auto-loop recoverable; a previously recoverable kind remains recoverable.

## 5. Gate and mirror

- [ ] 5.1 If `core/` changed: run `node scripts/build.mjs` and include regenerated `plugin/` in the same change.
- [ ] 5.2 Run `npm run ci` and fix failures until green.
- [ ] 5.3 Confirm `openspec validate review-prompt-too-large-preflight` still passes after any artifact touch-ups during implement.
