## Why

`pre_merge.ts` (~5400+ LOC) is the system’s complexity attractor: review-SHA gate, OpenSpec archive, CI recovery, conflict rebase, auto-fix, and polling orchestration share one file, so every new race (supersession, ceiling, currency, allowlisted identity) lands in the same procedure. Review was modularized into focused modules with a thin facade (`review.ts` re-exports); pre-merge was not. Issue-shaped tests paper over structure but do not replace it — ~11 pre-merge test files and months of audit churn concentrate on this file. Split is needed so ownership, review, and future policy fixes land in domain modules without reopening the whole monolith.

## What Changes

- Split `core/scripts/stages/pre_merge.ts` into focused stage modules (mirroring the review split), with a thin `pre_merge.ts` facade that re-exports the public surface so existing import sites (`pipeline-run.ts`, `merge-queue.ts`, `loop/repair-pipeline-item.ts`, and co-located tests) need no import-path changes.
- Preferred domain modules (names may vary slightly at implement time; domains are fixed):
  - **SHA-gate** — review currency, delta re-review, supersession/ceiling, notices, `enforceReviewShaGate` / `ShaGateDeps`
  - **OpenSpec archive** — active-change guard, archive-already-done, `maybeArchiveOpenspec` and related fail-closed paths
  - **CI gate** — recovery markers, zero-run recovery, definitive CI failure, exhausted/block reason builders, archive-only prior-green evaluation used by CI paths
  - **Conflict / rebase** — early/CI conflict recovery, rebase-attempted markers, `tryRebaseAndPush` / rebase push result resolution
  - **Facade / orchestration** — `advance` / `advancePolling`, shared opts/deps types, and any remaining glue that composes the modules above
- Prefer a **move-only** first landing: no intentional behavior change to SHA-gate policy, archive semantics, CI recovery, conflict rebase, or auto-fix outcomes.
- Keep existing pre-merge tests green; add import-boundary / facade smoke coverage if useful.
- Edit `core/`, regenerate `plugin/` via `node scripts/build.mjs` in the same change. No auto-merge.

## Acceptance criteria

- [ ] `core/scripts/stages/pre_merge.ts` is a thin re-export facade (same pattern as `stages/review.ts`), not the sole home of SHA-gate, OpenSpec archive, CI gate, and conflict-rebase implementations.
- [ ] Distinct modules under `core/scripts/stages/` own the SHA-gate, OpenSpec archive, CI-gate, and conflict/rebase domains (names may match `sha-gate.ts`, `openspec-archive.ts`, `ci-gate.ts`, `conflict-rebase.ts` or clear equivalents).
- [ ] Existing import sites that load from `stages/pre_merge.ts` continue to resolve the same exported symbols (facade re-exports); no required churn of every call site’s import path.
- [ ] Pre-merge product behavior is unchanged for the move: review-SHA currency/exemption, OpenSpec archive fail-closed, CI recovery markers and block reasons, conflict rebase bounds, and pre-merge auto-fix outcomes match pre-split living contracts.
- [ ] Existing pre-merge unit/regression tests still pass with injectable deps only (no real network/git/subprocess); any new facade/import-boundary smoke test fails if the monolith is re-collapsed or the facade drops required re-exports.
- [ ] `node scripts/build.mjs --check` reports the mirror in sync and `npm run ci` is green.
- [ ] No rewrite of SHA-gate policy logic, no harness-round extraction (sibling issue), and no auto-merge path is introduced.

## Capabilities

### New Capabilities

- `pre-merge-module-boundary`: Structural contract for splitting the pre-merge stage into domain modules with a thin facade re-export surface; move-only preservation of public exports and product behavior.

### Modified Capabilities

- None at the product-behavior level. Living capabilities (`review-sha-gating`, `pre-merge-ci-gate`, `pre-merge-conflict-detection`, OpenSpec archive / fail-closed requirements, `pre-merge-fix-round`, etc.) remain the behavioral source of truth; this change relocates implementation ownership without amending those requirements. If archive-time wording needs a one-line “implemented under pre-merge domain modules” note, that is optional and not a requirement delta.

## Impact

- **Core modules:** `core/scripts/stages/pre_merge.ts` becomes a facade; new sibling modules under `core/scripts/stages/` for the domains above; internal imports among those modules and any shared types/constants.
- **Call sites:** Prefer zero import-path changes via re-exports (`pipeline-run.ts`, `merge-queue.ts`, `loop/repair-pipeline-item.ts`, tests). Direct imports of new module paths are allowed for new tests only.
- **Tests:** All existing `pre-merge-*.test.ts` and consumers of pre-merge exports stay green; optional boundary smoke.
- **Living specs:** New `pre-merge-module-boundary` capability only (no intentional requirement deltas on gate policy specs).
- **Generated mirror:** `plugin/` regenerated with `node scripts/build.mjs`.
- **Out of scope:** Rewriting SHA-gate policy; extracting shared harness-round (sibling); auto-fix policy redesign; auto-merge; review-policy weakening.
