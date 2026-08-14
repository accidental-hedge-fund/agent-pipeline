## 1. Recovery seam and types

- [x] 1.1 Inventory every pre-merge path that calls `setBlocked(..., "merge-conflict")` or returns the “manual rebase needed” terminal after clean auto-rebase failure (early-conflict, post-CI CONFLICTING/DIRTY, shared `recoverFromMergeConflict`, CI-gate rebase helpers if shared).
- [x] 1.2 Define the bounded conflict-resolution result shape (success → push/re-enter; in-progress/waiting; budget-exhausted product failure with conflict paths) and injectable deps seams for resolve + implementer (no real network/git in unit tests).
- [x] 1.3 Choose the product/engine-owned `BlockerKind` for budget-exhausted residual conflict from the existing enum (not `merge-conflict` + manual-rebase text) and document it in code comments / blocked reason builders.

## 2. Core recovery behavior

- [x] 2.1 Change `tryRebaseAndPush` / conflict detection so a conflicted rebase is not treated as a terminal human park; keep managed worktree ownership for resolve.
- [x] 2.2 Implement bounded conflict resolution in `recoverFromMergeConflict` (deterministic-first when safe, then configured implementer under surgical-fix scope with conflict file evidence).
- [x] 2.3 On successful resolve: complete rebase, `git push --force-with-lease` via existing push-auth, re-read head when required, return non-blocked waiting “rebase-resolved; CI re-running” (or equivalent per existing head-moved rules).
- [x] 2.4 On budget exhaust with residual conflicts: `setBlocked` with product/engine-owned kind + conflict paths; never emit the #1061 legal terminal string under `merge-conflict`.
- [x] 2.5 Adjust stage-attempt ledger / `reconcileConflictRebaseState` so a clean-rebase claim miss escalates to resolve instead of `block_manual_rebase` / instant human park; still prevent unlimited clean-rebase thrash.
- [x] 2.6 Ensure both early-conflict and post-CI CONFLICTING/DIRTY call sites share the same recovery law (class-over-site).

## 3. Classification and operator surfaces

- [x] 3.1 Update pre-merge offramp mapping so first-conflict recovery does not durable-record terminal `offramp_class: merge-conflict`; map budget-exhausted product failure to the kind actually used.
- [x] 3.2 Ensure human-intervention / stage-diagnostic projection does not treat first-conflict as human-authority “manual rebase” hold.
- [x] 3.3 Keep `BLOCKER_RECIPES["merge-conflict"]` defined if the kind remains for other surfaces; confirm pre-merge first-conflict no longer posts that recipe as terminal.

## 4. Multi-item / train disposition

- [x] 4.1 Confirm multi-item advance / train cannot treat first-conflict false park as a completed human disposition that alone starts the next issue while this item is unmerged; adjust disposition only as needed for this class (full #1063 remains out of scope).

## 5. Tests

- [x] 5.1 Regression: first clean auto-rebase conflict with budget remaining never calls `setBlocked` with `merge-conflict` / “manual rebase needed.”
- [x] 5.2 Regression: #1061 18:07Z-class terminal text is not a legal first-conflict terminal (test fails if reintroduced).
- [x] 5.3 Fixture/path: additive help-string union conflict class resolves and pushes without `blocked` when resolve is injected successful.
- [x] 5.4 Budget exhaust with still-conflicting tree → product/engine-owned block with conflict-file evidence, not merge-conflict manual-rebase.
- [x] 5.5 Successful resolve → waiting / CI re-running; head-moved / unverified rules preserved.
- [x] 5.6 Update existing tests that currently expect instant `merge-conflict` park after `tryRebaseAndPush === false` (convergence, conflict-rebase, offramp, recipes as needed).
- [x] 5.7 All new tests use deps injection only (no real network, git, or subprocess).

## 6. Mirror, validate, CI

- [x] 6.1 If `core/` changed: `node scripts/build.mjs` and commit regenerated `plugin/` in the same change.
- [x] 6.2 `openspec validate pre-merge-never-park-merge-conflict` (and `openspec validate --all` as part of full gate).
- [x] 6.3 `npm run ci` green from repo root.
