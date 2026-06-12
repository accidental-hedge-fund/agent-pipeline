## 1. Types

- [x] 1.1 Add `BlockerKind` string-enum to `core/scripts/types.ts` with all 12 values: `needs-human`, `test-gate-exhausted`, `no-commits`, `harness-failure`, `openspec-invalid`, `openspec-stale-delta`, `merge-conflict`, `worktree-missing`, `worktree-creation-failed`, `pr-creation-failed`, `plan-gen-failed`, `push-failed` (implemented as a `BLOCKER_KINDS` const array + derived `BlockerKind` type, mirroring the existing `STAGES`/`Stage` pattern so the exhaustiveness test has a runtime source of truth)
- [x] 1.2 Add `BLOCKER_RECIPES: Record<BlockerKind, string>` map to `types.ts` with a recovery recipe string for each kind (recipes use a `{{N}}` issue-number placeholder substituted at render time)

## 2. Core function

- [x] 2.1 Update `setBlocked` signature in `core/scripts/gh.ts` to accept an optional fifth parameter `kind: BlockerKind = DEFAULT_BLOCKER_KIND`
- [x] 2.2 Update the "### How to unblock" section in the blocked comment body to render the kind's recipe (via the pure, exported `buildBlockedComment` / `renderRecipe` helpers) instead of the hard-coded `--unblock` instruction

## 3. Call-site wiring

- [x] 3.1 Update every `setBlocked(...)` call in `core/scripts/stages/planning.ts` to pass the correct `BlockerKind` (plan-gen-failed, harness-failure, needs-human, worktree-creation-failed, no-commits, test-gate-exhausted, push-failed, pr-creation-failed, openspec-invalid as appropriate per call)
- [x] 3.2 Update every `setBlocked(...)` call in `core/scripts/stages/fix.ts` to pass the correct `BlockerKind` (worktree-missing, harness-failure, no-commits, needs-human, openspec-invalid, test-gate-exhausted, push-failed)
- [x] 3.3 Update every `setBlocked(...)` call in `core/scripts/stages/pre_merge.ts` to pass the correct `BlockerKind` (needs-human, test-gate-exhausted, merge-conflict, openspec-invalid, push-failed, and the stale-delta call → `openspec-stale-delta`)

Scope note: per `design.md`, the curated 12-class taxonomy covers the blocker classes in `planning.ts`, `fix.ts`, and `pre_merge.ts`. `review.ts` / `eval.ts` blockers (transient gh/diff/SHA anomalies) fall outside that taxonomy and keep the backward-compatible `needs-human` default.

## 4. Tests

- [x] 4.1 Add a unit test asserting that `BLOCKER_RECIPES` has a non-empty entry for every `BlockerKind` value (exhaustiveness guard) — `core/test/blocked-recipes.test.ts`
- [x] 4.2 Add snapshot/string assertions for each kind's rendered blocked comment — verify the recipe text appears under "### How to unblock" and the generic `--unblock` instruction does NOT appear (asserted for **all** kinds, including needs-human)
- [x] 4.3 Add a test for the default-kind fallback: `DEFAULT_BLOCKER_KIND` (the `setBlocked` default) renders the `needs-human` recipe
- [x] 4.4 Prove the exhaustiveness test bites: temporarily removed the `push-failed` entry → the exhaustiveness + snapshot tests failed naming `push-failed`; restored → green

## 5. Mirror & CI

- [x] 5.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`
- [x] 5.2 Run `npm run ci` from the repo root — all checks pass (597 core tests, mirror in sync, install-smoke ok)
