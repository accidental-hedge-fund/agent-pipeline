## 1. Pre-archive dirt decision

- [ ] 1.1 In `core/scripts/stages/pre-merge-openspec-archive.ts`, after successful `git status --porcelain`, classify residual dirt with the shared worktree classifier (`parsePorcelainPaths` + `productDirtyPaths` / `classifyWorktreeDirt`) so `artifacts/challenge-response-*.json` is non-product scratch, while keeping pipeline-internal marker exclusion (`stripPipelineInternalMarkers` / marker unlink) intact.
- [ ] 1.2 Block with `setBlocked` (`needs-human`) only when **product** dirt remains; when residual is only challenge-response scratch and/or markers, do **not** `setBlocked` and proceed with archive evaluation.
- [ ] 1.3 Optionally best-effort unlink/clean challenge-response scratch when it is the only residual (same spirit as marker-only cleanup); never stage or commit the dump.
- [ ] 1.4 Keep fail-closed behavior for nonzero `git status` and for product / dirty `openspec/` porcelain (including rename endpoints that remain product).

## 2. Unit regressions

- [ ] 2.1 Add `maybeArchiveOpenspec` regression: porcelain only `?? artifacts/challenge-response-N.json` (exit 0) → `setBlocked` not called for that dirt alone; archive evaluation may proceed when candidates exist.
- [ ] 2.2 Add mixed case: challenge-response dump + product path (e.g. `core/scripts/foo.ts` or dirty `openspec/specs/...`) → still blocks; archive not invoked.
- [ ] 2.3 Confirm existing tests still pass: product-only dirty, dirty `openspec/`, marker-only proceed, rename outside `openspec/`, failed status fail-closed (`pre-merge-spec-consistency.test.ts` and related).
- [ ] 2.4 Prove the challenge-response-only test **bites** without the fix (would call `setBlocked`).

## 3. Mirror, validate, CI

- [ ] 3.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [ ] 3.2 Run `openspec validate pre-merge-archive-challenge-response-scratch` (and `openspec validate --all` as needed) until clean.
- [ ] 3.3 Run `npm run ci` from the repo root and fix failures until green.
