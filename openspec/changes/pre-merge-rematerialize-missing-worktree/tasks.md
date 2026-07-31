## 1. Rematerialize seam (`ensureManagedWorktree`)

- [x] 1.1 Implement injectable `ensureManagedWorktree` with fixed result contract: `{ result: pass|skipped|fail, worktree, reason, blockerKind? }`.
- [x] 1.2 Lookup: on-disk managed path present → `skipped` (no force recreate). Absent / stale metadata without path → rematerialize.
- [x] 1.3 Create path: delegate to `createWorktree` (same startPoint + #622 reclaim). Slug from `slugify(issue title)`.
- [x] 1.4 After create: verify worktree `HEAD` equals open-PR `head_sha` when open PR exists, else verified remote tip SHA; mismatch → `fail` + `worktree-creation-failed` and remove/quarantine the just-created managed path so re-entry cannot skip on the mismatched tree (#769 review-2).
- [x] 1.5 Map failures: capacity → `worktree-capacity`; create/reclaim/auth/branch/HEAD → `worktree-creation-failed`; no recoverable identity → `worktree-missing`.
- [x] 1.6 When `runDir` present, always append `gate_result` gate=`worktree-rematerialize` for pass/fail/skipped with bounded reason.
- [x] 1.7 Plumb seam through `AdvancePreMergeDeps` / fix deps / autofix production closure; unit tests inject fakes only.

## 2. Call site A — OpenSpec archive (`maybeArchiveOpenspec`)

- [x] 2.1 On missing worktree: list PR-tip active change dirs at PR head SHA (`listPrHeadChangeDirs`); fail-closed on listing errors.
- [x] 2.2 Empty tip membership → skip (`null`); no rematerialize required for archive.
- [x] 2.3 Active membership **or** membership unconfirmed → call `ensureManagedWorktree` before parking.
- [x] 2.4 On pass: re-resolve worktree; continue existing archive path.
- [x] 2.5 On fail: one typed block (`worktree-missing` / `worktree-creation-failed` / `worktree-capacity`); never `null` while active/unknown; never bare `needs-human` for absence-only.

## 3. Call sites B+C — Pre-merge autofix (normal + residual re-entry)

- [x] 3.1 In production `attemptPreMergeAutoFix` closure (covers normal delta autofix **and** `reuseBlockedBy` residual re-entry), rematerialize when lookup is null **before** bare `{ status: "error" }` or `performPreMergeAutoFix`.
- [x] 3.2 On pass: run autofix against recreated path.
- [x] 3.3 On fail: return autofix failure with diagnostic naming rematerialize/worktree failure (not empty bare `error`); durable rematerialize fail event when runDir present.

## 4. Call site D — Fix stage write path (`advanceFix`)

- [x] 4.1 When worktree missing, call `ensureManagedWorktree` once before `worktree-missing` block.
- [x] 4.2 On pass continue fix round; on fail `setBlocked` with seam `blockerKind` + reason.

## 5. Recipes

- [x] 5.1 Update `BLOCKER_RECIPES["worktree-missing"]` so it does not claim re-run always blocks without recreation for scoped paths.
- [x] 5.2 Adjust `blocked-recipes.test.ts` to match honest residual recovery wording (auth/PR recoverability/capacity/dirty reclaim).

## 6. Tests (injectable deps only; no real network/git)

- [x] 6.1 Missing worktree + active OpenSpec tip change → rematerialize → archive proceeds.
- [x] 6.2 Missing worktree + residual re-entry autofix eligible → rematerialize before autofix; autofix sees recreated path.
- [x] 6.3 Rematerialize failure → typed block; no silent archive skip when active change remains.
- [x] 6.4 Membership unconfirmed (listing throws) → rematerialize attempted; fail → typed block (not `null`).
- [x] 6.5 Already-present worktree → `skipped`; no create call; durable skipped event when runDir set.
- [x] 6.6 Stale manager metadata / absent on-disk path → treated as missing; rematerialize invoked.
- [x] 6.7 HEAD mismatch after create → `fail` + `worktree-creation-failed`; mismatched managed path is removed; re-entry does not `skip` on that tree.
- [x] 6.8 Failure mapping: capacity / reclaim-dirty / reclaim-local-only / auth-or-branch → correct `blockerKind`.
- [x] 6.9 Regression: #622 dirty / local-only / unverifiable candidate under managed root refuses destructive reclaim.
- [x] 6.10 Durable events: pass / fail / skipped each recorded with gate `worktree-rematerialize` when runDir present.
- [x] 6.11 Prove bite: remove rematerialize wiring and confirm core tests fail.

## 7. Ship

- [x] 7.1 `openspec validate pre-merge-rematerialize-missing-worktree` (and `openspec validate --all`) green.
- [x] 7.2 After implementation: `node scripts/build.mjs` and commit regenerated `plugin/` if `core/` changed.
- [x] 7.3 After implementation: `npm run ci` green from repo root.
- [ ] 7.4 Dogfood: re-advance #626 / #729 after install does not park solely for “worktree not found” when PR branch is recoverable.
