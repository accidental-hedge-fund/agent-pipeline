## 1. Inventory and cut plan

- [ ] 1.1 Inventory every public export from `stages/pre_merge.ts` and every production/test importer of that path
- [ ] 1.2 Map each export and large private helper to a domain (SHA-gate, OpenSpec archive, CI gate, conflict/rebase, autofix, orchestration)
- [ ] 1.3 Choose final filenames (`pre-merge-*.ts` vs short names) and confirm the import graph will be acyclic (domain modules must not import the facade)
- [ ] 1.4 Decide autofix placement for the first PR (fifth module vs temporary co-location in orchestration) per design Decision 3

## 2. Extract leaf domain modules (move-only)

- [ ] 2.1 Extract conflict/rebase helpers and markers into the conflict-rebase domain module without logic changes
- [ ] 2.2 Extract CI recovery markers + CI failure / zero-run / exhausted-reason paths into the CI-gate domain module without logic changes
- [ ] 2.3 Extract OpenSpec archive helpers (`archiveAlreadyDone`, active-change guard, `maybeArchiveOpenspec`) into the archive domain module without logic changes
- [ ] 2.4 Extract SHA-gate (`enforceReviewShaGate`, `ShaGateDeps`, currency, delta helpers, notices) into the SHA-gate domain module without logic changes
- [ ] 2.5 Place autofix per Decision 3; keep export names and behavior identical
- [ ] 2.6 Keep `isPipelineInternalCommit` ownership in neutral `pipeline-commits.ts` (re-export from facade only if already done)

## 3. Facade and orchestration

- [ ] 3.1 Convert `stages/pre_merge.ts` into a thin re-export facade (and optional thin routing) analogous to `stages/review.ts`
- [ ] 3.2 Ensure `advance` / `advancePolling` still compose domains in the same order with the same `AdvancePreMergeOpts` / deps seams
- [ ] 3.3 Re-export the full prior public surface so existing import paths keep resolving
- [ ] 3.4 Verify domain modules do not import `./pre_merge.ts`

## 4. Tests and structural guards

- [ ] 4.1 Run existing pre-merge unit/regression suites (`pre-merge-*.test.ts` and direct consumers); keep them on the facade import path unless a deep import is intentionally added
- [ ] 4.2 Add a lightweight facade/export or module-boundary regression (canary public exports and/or domain-module presence; no domain→facade import) if useful
- [ ] 4.3 Confirm unit tests still inject I/O via deps only (no real network/git/subprocess)

## 5. Mirror, validate, CI

- [ ] 5.1 Run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 5.2 Run `openspec validate split-pre-merge-modules` (and `openspec validate --all` as needed)
- [ ] 5.3 Run `npm run ci` from repo root and fix failures until green
- [ ] 5.4 Confirm the PR does not rewrite SHA-gate policy or extract harness-round; no auto-merge path added
