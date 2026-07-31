## 1. Rematerialize seam

- [ ] 1.1 Add an injectable `ensureManagedWorktree` / rematerialize helper (thin wrapper over `createWorktree` or shared startPoint path) that: no-ops when lookup already finds a worktree; otherwise creates from remote branch tip / open PR head with existing reclaim safety.
- [ ] 1.2 Wire durable run evidence (`gate_result` or stage event) for rematerialize `pass` / `fail` / optional `skipped` when a run dir is present.
- [ ] 1.3 Plumb the seam through `AdvancePreMergeDeps` (and fix-stage deps as needed) with production defaults; no real network in unit tests.

## 2. OpenSpec archive call site

- [ ] 2.1 In `maybeArchiveOpenspec`, when worktree lookup is null and tip still has active OpenSpec change(s) (or tip listing fails closed), call rematerialize before blocking.
- [ ] 2.2 On rematerialize success, re-resolve the worktree and continue the existing archive path (cleanliness guard, archive, commit, push).
- [ ] 2.3 On rematerialize failure, block with `worktree-missing` / `worktree-creation-failed` (not bare `needs-human`) and do **not** return `null` while active tip changes remain.
- [ ] 2.4 Preserve non-blocking skip when tip has no active OpenSpec change dirs and worktree is missing.

## 3. Pre-merge autofix / residual re-entry

- [ ] 3.1 In the production autofix closure (and residual re-entry path), rematerialize when worktree is null before returning `{ status: "error" }` or invoking `performPreMergeAutoFix`.
- [ ] 3.2 On rematerialize success, run autofix against the recreated path.
- [ ] 3.3 On rematerialize failure, surface typed diagnostic / gate fail (`residual-reentry` or rematerialize fail) without pretending product residual judgment alone caused the miss.

## 4. Fix stage write path

- [ ] 4.1 When fix would park solely for missing worktree, attempt rematerialize once before `worktree-missing` block.
- [ ] 4.2 On success continue the fix round; on failure keep typed worktree block with accurate recovery text.

## 5. Recipes

- [ ] 5.1 Update `BLOCKER_RECIPES["worktree-missing"]` so it does not claim re-run never recreates for scoped rematerialize paths.
- [ ] 5.2 Adjust `blocked-recipes.test.ts` (and any related assertions) to match honest residual recovery wording.

## 6. Tests

- [ ] 6.1 Unit test: missing worktree + active OpenSpec tip change → rematerialize invoked → archive proceeds (fakes; no real network/git).
- [ ] 6.2 Unit test: missing worktree + residual re-entry autofix eligible → rematerialize before autofix; autofix sees recreated path.
- [ ] 6.3 Unit test: rematerialize failure → typed block; no silent archive skip when active change remains.
- [ ] 6.4 Regression: dirty / local-only reclaim safety (#622) still refuses force-destroy (existing or new fakes).
- [ ] 6.5 Prove bite: temporarily remove rematerialize wiring and confirm 6.1–6.3 fail.

## 7. Ship

- [ ] 7.1 `openspec validate pre-merge-rematerialize-missing-worktree` green.
- [ ] 7.2 After implementation: `node scripts/build.mjs` and commit regenerated `plugin/` if `core/` changed.
- [ ] 7.3 After implementation: `npm run ci` green from repo root.
- [ ] 7.4 Dogfood: re-advance #626 / #729 after install does not park solely for “worktree not found” when PR branch is recoverable.
