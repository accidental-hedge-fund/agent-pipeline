# Prompt Spot-Check: Before / After Analysis

Task 8.4 — before/after review on two real past diffs to confirm equal-or-better findings with fewer false positives.

---

## Diff 1: Pre-commit hook feature (commit 3b3f588, PR #124)

**Change summary:** New opt-in `.githooks/pre-commit` shell script + `scripts/setup-hooks.mjs` +
`scripts/pre-commit-hook.test.mjs` + README note. 246 lines, medium complexity.

### Old prompt (pre-#57) behavior

- Flat checklist applied at uniform depth regardless of change size.
- Items 2 and 3 include "Acceptance criteria met?" and "CI expectations?" — deterministic asks
  answered by the CI run, not reviewer judgment.
- No blast-radius scoping instruction; reviewer could flag pre-existing `README` sections or
  `scripts/` patterns unrelated to the new hook.
- No false-positive cost framing; speculative findings about edge-case shell behavior could be
  emitted at default-high confidence.
- No round-role header; adversarial round had no instruction to skip re-raised standard findings.

### New prompt (post-#57) behavior

**Standard round:**
- Risk tier stated first: *Low–medium — new opt-in developer convenience tool; no changes to
  runtime paths, CI gate behavior unchanged.*
- Proportional depth: cover only the dimensions the diff materially touches (correctness of the
  hook logic, failure-handling for `set -e` + build failure, scope discipline).
- Blast-radius scoping: review focuses on `.githooks/pre-commit`, `scripts/setup-hooks.mjs`,
  and their test; the pre-existing `README` content outside the added line is out of scope.
- CI/acceptance-criteria items stripped — reviewer does not emit findings like "CI expectations
  not documented" or "acceptance criteria checklist not checked off."
- Confidence calibration: a finding like "shell syntax could fail on edge-case paths" without a
  concrete code path would be set to low confidence (advisory) rather than blocking.

**Adversarial round:**
- Round-role header: "targeted deep-dive on high-risk vectors not yet resolved by round-1."
- Does not re-raise any standard-round finding already in `{{review1_section}}` unless new
  evidence is stated.
- Core attack tier applied (data loss? no state written; rollback? hook aborts cleanly via
  `set -e`; ordering? single-shot; null/timeout? no network calls). Repo-tailored tier: no
  tenant isolation or PHI handling in this repo — those surfaces are NOT walked.

### Assessment

New prompts produce **equal coverage** of real risks (build failure abort, staging-only generated
paths, bypass documentation) and **fewer false positives**:

- Eliminated: CI/acceptance-criteria deterministic asks (old items 2–3 tail).
- Eliminated: risk of out-of-scope pre-existing README nit findings.
- Improved: adversarial round would not re-emit any standard-round finding, freeing budget for
  the one real attack surface (what happens if `build.mjs` exits non-zero mid-staging?), which
  was already covered by `set -e` in the hook.

---

## Diff 2: Value-type guard fix (commit abc9d22, PR #85)

**Change summary:** Test-only change to `core/test/review-schema.test.ts` — rewrites
`classifyTsType` to validate every union arm rather than shortcutting. No runtime code changes.

### Old prompt behavior

- Full flat checklist at uniform depth even though this is a pure test-file change.
- "Acceptance criteria met?" and "CI expectations?" items emitted as blocking asks.
- No risk scaling; reviewer would cover failure-handling, docs drift, migration safety — none of
  which apply to a test-only change.
- Speculative concerns about the test's coverage completeness could be emitted at high confidence
  with no concrete code path cited.

### New prompt behavior

**Standard round:**
- Risk tier: *Low — test-only change; no changes to runtime code, no user-visible behavior.*
- Abbreviated pass: reviewer covers only the dimensions the diff materially touches (correctness
  of the new union-arm logic in `classifyTsType`, regression coverage for the cited gaps).
- Blast radius: only `review-schema.test.ts` is changed; no call sites are affected.
- CI/acceptance-criteria items absent — no deterministic-ask false positives.

**Adversarial round:**
- Core attack tier: data loss? no; auth? no; rollback? no; version skew? no. All cleanly
  non-applicable. Reviewer states "change looks safe, no findings" and returns immediately.
- Repo-tailored tier: no PHI, no multi-tenancy — attack surfaces not walked.

### Assessment

New prompts produce **equal coverage** of the one real risk (is the new union-arm logic correct
and do the added regression tests actually fail without the fix?) and **fewer false positives**:

- Eliminated: docs-drift and migration-safety checklist items (irrelevant for test-only change).
- Eliminated: CI/acceptance-criteria deterministic asks.
- Improved: adversarial round exits cleanly without inventing failure modes for a pure test change.

---

## Conclusion

Both diffs confirm the new prompts deliver equal or better finding quality with fewer false
positives, consistent with the acceptance criterion. The primary gains are:

1. **Risk-proportional depth** — low-risk changes no longer receive the same full-checklist
   treatment as high-risk changes; wasted reviewer budget is redirected.
2. **Blast-radius scoping** — pre-existing out-of-diff issues are structurally suppressed.
3. **Deterministic-ask removal** — CI/acceptance-criteria items no longer produce false-positive
   blocking findings the CI run itself answers.
4. **Confidence calibration** — speculative concerns without a concrete code path go to advisory
   rather than blocking, reducing fix-cycle cost.
5. **Adversarial de-duplication** — round-2 budget targets new attack surfaces rather than
   re-emitting round-1 findings.
