## 1. Inventory and ownership layout

- [ ] 1.1 Inventory every `opts.*` read in `pipeline-run.ts` (and advance-only helpers) to lock the `AdvanceOpts` field set
- [ ] 1.2 Choose ownership layout per design (neutral module for shared helpers; `AdvanceOpts` on run or neutral module) so neither module reintroduces a run→CLI import
- [ ] 1.3 Confirm which stage imports in `pipeline.ts` are still referenced vs dead

## 2. Shared helpers and AdvanceOpts

- [ ] 2.1 Introduce single-sourced `REVIEW_CEILING_MARKER`, `ceilingRound`, and `evidenceTimestamp` in the chosen owner module
- [ ] 2.2 Point `pipeline.ts` and `pipeline-run.ts` at the shared definitions; delete private duplicates and “kept in sync manually” comments
- [ ] 2.3 Re-export `ceilingRound` (and any other needed symbols) from `pipeline.ts` so existing test import paths keep working
- [ ] 2.4 Define and export `AdvanceOpts` with only the inventoried advance fields

## 3. Break the cycle at the advance API

- [ ] 3.1 Change `runAdvance` and `dispatch` (and any advance-only helpers typed as `CliOpts`) to accept `AdvanceOpts`
- [ ] 3.2 Remove `import type { CliOpts } from "./pipeline.ts"` (and any other `pipeline.ts` import) from `pipeline-run.ts`
- [ ] 3.3 At the CLI advance call site, map fat `CliOpts` → `AdvanceOpts` (explicit pick or pure mapper)
- [ ] 3.4 Update tests that construct advance opts bags to use `AdvanceOpts` / the mapped shape without requiring kitchen-sink fields

## 4. Dead imports and cleanliness

- [ ] 4.1 Remove dead stage imports from `pipeline.ts`; retain still-used ones (e.g. review-stage ceiling helpers)
- [ ] 4.2 Avoid unrelated refactors of stage modules or non-advance command handlers

## 5. Regression coverage

- [ ] 5.1 Add a regression test that fails if `pipeline-run.ts` reintroduces an import from `pipeline.ts` (source scan or equivalent runtime-checkable guard)
- [ ] 5.2 Add or extend pure tests proving shared `ceilingRound` / marker identity or parity (and keep existing `ceilingRound` cases green via re-export)
- [ ] 5.3 Confirm existing advance lifecycle / override tests pass with injectable deps only (no real network/git/subprocess)

## 6. Mirror, validate, CI

- [ ] 6.1 Run `node scripts/build.mjs` and include regenerated `plugin/` in the same change
- [ ] 6.2 Run `openspec validate split-advance-opts-from-cliopts` (and `openspec validate --all` as needed)
- [ ] 6.3 Run `npm run ci` from repo root and fix any failures until green
