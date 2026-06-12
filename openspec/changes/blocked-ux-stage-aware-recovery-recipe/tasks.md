## 1. Types

- [ ] 1.1 Add `BlockerKind` string-enum to `core/scripts/types.ts` with all 12 values: `needs-human`, `test-gate-exhausted`, `no-commits`, `harness-failure`, `openspec-invalid`, `openspec-stale-delta`, `merge-conflict`, `worktree-missing`, `worktree-creation-failed`, `pr-creation-failed`, `plan-gen-failed`, `push-failed`
- [ ] 1.2 Add `BLOCKER_RECIPES: Record<BlockerKind, string>` map to `types.ts` with a recovery recipe string for each kind

## 2. Core function

- [ ] 2.1 Update `setBlocked` signature in `core/scripts/gh.ts` to accept an optional fifth parameter `kind?: BlockerKind`
- [ ] 2.2 Update the "### How to unblock" section in the blocked comment body to render `BLOCKER_RECIPES[kind ?? "needs-human"]` instead of the hard-coded `--unblock` instruction

## 3. Call-site wiring

- [ ] 3.1 Update every `setBlocked(...)` call in `core/scripts/stages/planning.ts` to pass the correct `BlockerKind` (harness-failure, no-commits, openspec-invalid, worktree-missing, worktree-creation-failed, pr-creation-failed, plan-gen-failed, test-gate-exhausted, merge-conflict, needs-human as appropriate per call)
- [ ] 3.2 Update every `setBlocked(...)` call in `core/scripts/stages/fix.ts` to pass the correct `BlockerKind`
- [ ] 3.3 Update the `setBlocked(...)` call in `core/scripts/stages/pre_merge.ts` to pass `openspec-stale-delta`

## 4. Tests

- [ ] 4.1 Add a unit test asserting that `BLOCKER_RECIPES` has a non-empty entry for every `BlockerKind` value (exhaustiveness guard)
- [ ] 4.2 Add snapshot/string assertions for each kind's rendered blocked comment — verify the recipe text appears under "### How to unblock" and the generic `--unblock` instruction does NOT appear (for non-needs-human kinds)
- [ ] 4.3 Add a test for the default-kind fallback: calling `setBlocked` without `kind` renders the `needs-human` recipe
- [ ] 4.4 Prove the exhaustiveness test bites: temporarily remove one entry from `BLOCKER_RECIPES` and confirm the test fails, then restore

## 5. Mirror & CI

- [ ] 5.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/`
- [ ] 5.2 Run `npm run ci` from the repo root — all checks must pass before marking done
