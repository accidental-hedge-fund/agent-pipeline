## 1. Pre-filter overridden findings from the fix scope at entry

- [x] 1.1 In `advanceFix` (fix.ts), after building `trustedForAck`, derive live
      overrides via `extractOverrides` / `extractScopedOverrides` over the trusted
      comments and compute the effective blocking set for the triggering review by
      subtracting findings matched by `findingKey` (key overrides) or
      `matchFindingScope` (scope overrides) — reusing the `review-policy.ts`
      identity functions, never a re-implementation.
- [x] 1.2 When the effective blocking set is empty, skip the harness invocation and
      transition (round 1 → `review-2`, round 2 → `pre-merge`) with an audited
      comment itemizing which override dispositioned each triggering finding.
- [x] 1.3 When the effective set is partial, invoke the harness with only the
      remaining, non-overridden findings rendered into the fix prompt (extend
      `extractBlockingReviewFindings` / `filterToBlockingFindings` to subtract the
      override-matched keys/scopes in addition to the frozen advisory marker).

## 2. Sanction a "does not reproduce" harness outcome

- [x] 2.1 `fix.md`: add the sanctioned outcome — when the harness makes no change
      because an assigned blocking finding does not reproduce at the reviewed SHA,
      it emits one controlled per-finding declaration carrying the finding key, the
      reviewed SHA, and a one-line justification (instead of silently not
      committing). Keep the sentinel shape formatter-owned and drift-guarded.
- [x] 2.2 `prompt-loader.test.ts`: add a drift assertion that bites when the
      does-not-reproduce instruction is removed from the fix prompt, and asserts the
      rendered prompt contains no unfilled `{{placeholder}}`.

## 3. Recognize the non-reproducing outcome on the no-commit path

- [x] 3.1 In `advanceFix`, on the `headBefore === headAfter` + salvage-empty path,
      parse `result.stdout` for does-not-reproduce declarations before the
      `no-commits` block. Validate each: key ∈ invoked blocking set AND reviewed SHA
      == current `HEAD`; ignore invalid declarations (fail closed).
- [x] 3.2 When every invoked blocking finding is covered by a valid declaration,
      advance (round 1 → `review-2`, round 2 → `pre-merge`) with an audited
      transition message; otherwise fall through to the existing `no-commits` block.
- [x] 3.3 Extract the declaration parser/validator as an exported pure function
      (mirroring `decideExternalCommitAdvance`) so it is unit-testable in isolation.

## 4. Record and consult the SHA-anchored disposition

- [x] 4.1 On a does-not-reproduce advance, post an audited disposition comment
      carrying a sentinel distinct from `pipeline-override`, recording the finding
      key, the reviewed SHA, the stage, and the justification.
- [x] 4.2 At fix/review entry, consult recorded non-reproducing dispositions
      (trusted-author filtered) and treat a finding as dispositioned only when the
      recorded reviewed SHA equals the current reviewed SHA; a SHA change re-opens
      the finding.

## 5. Modify the fix-external-commit-advance block requirement

- [x] 5.1 The "block when HEAD equals reviewed SHA" path yields to two carve-outs:
      an empty effective blocking set, and a valid does-not-reproduce declaration set
      covering every invoked blocking finding. All other equal-SHA no-op cases still
      block with `no-commits`.

## 6. Tests (bite against the pre-change fix stage)

- [x] 6.1 All triggering blockers overridden → harness NOT invoked; advances to the
      correct next stage; no `setBlocked`.
- [x] 6.2 Partial overrides → harness invoked; prompt scope excludes the overridden
      findings; includes the remaining ones.
- [x] 6.3 All invoked blockers declared non-reproducing (valid key + matching SHA)
      → advances; no `no-commits` block; disposition sentinel posted.
- [x] 6.4 A no-op round with an invoked blocker neither committed, overridden, nor
      validly declared → still blocks with `blockerKind: "no-commits"` (fail closed).
- [x] 6.5 A declaration with a key outside the invoked set, or a SHA ≠ current HEAD,
      is ignored (does not force an advance).
- [x] 6.6 SHA-anchored consultation: re-entry at the same reviewed SHA suppresses the
      finding; re-entry after a SHA change re-opens it.
- [x] 6.7 Genuine reproducing finding → normal fix-and-commit flow unchanged.

## 7. Mirror + CI

- [x] 7.1 `node scripts/build.mjs`; `npm run ci` green.
