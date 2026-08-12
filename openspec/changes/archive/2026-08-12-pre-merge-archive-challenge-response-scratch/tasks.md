## 1. Pre-archive dirt decision

- [x] 1.1 In `core/scripts/stages/pre-merge-openspec-archive.ts`, after successful `git status --porcelain`, classify residual dirt with the shared worktree classifier (`parsePorcelainPaths` + `productDirtyPaths` / `classifyWorktreeDirt`) so `artifacts/challenge-response-*.json` is non-product scratch, while keeping pipeline-internal marker exclusion (`stripPipelineInternalMarkers` / marker unlink) intact.
- [x] 1.2 Block with `setBlocked` (`needs-human`) only when **product** dirt remains; when residual is only challenge-response scratch and/or markers, do **not** `setBlocked` and proceed with archive evaluation.
- [x] 1.3 Optionally best-effort unlink/clean challenge-response scratch when it is the only residual (same spirit as marker-only cleanup); never stage or commit the dump.
- [x] 1.4 Keep fail-closed behavior for nonzero `git status` and for product / dirty `openspec/` porcelain (including rename endpoints that remain product).
- [x] 1.5 Preserve porcelain status while classifying scratch (#1017 review 1): only pure untracked (`??`) scratch is waivable + cleaned; tracked/staged/modified challenge-response blocks pre-archive.
- [x] 1.6 After archive `git add -A`, unstage any residual engine-known scratch before commit so challenge-response JSON cannot enter the archive commit.
- [x] 1.7 Fail closed when post-archive `git restore --staged` exits nonzero or XY-preserving porcelain still shows engine-known scratch staged — block before commit (#1017 review 2).

## 2. Unit regressions

- [x] 2.1 Add `maybeArchiveOpenspec` regression: porcelain only `?? artifacts/challenge-response-N.json` (exit 0) → `setBlocked` not called for that dirt alone; archive evaluation may proceed when candidates exist.
- [x] 2.2 Add mixed case: challenge-response dump + product path (e.g. `core/scripts/foo.ts` or dirty `openspec/specs/...`) → still blocks; archive not invoked.
- [x] 2.3 Confirm existing tests still pass: product-only dirty, dirty `openspec/`, marker-only proceed, rename outside `openspec/`, failed status fail-closed (`pre-merge-spec-consistency.test.ts` and related).
- [x] 2.4 Prove the challenge-response-only test **bites** without the fix (would call `setBlocked`).
- [x] 2.5 Add tracked/modified challenge-response + active archive candidate → `setBlocked`, archive not invoked; helper unit for untracked vs tracked classification.
- [x] 2.6 Add post-archive residual scratch → unstaged before commit (no auto-commit of challenge-response JSON).
- [x] 2.7 Add restore `--staged` failure → `setBlocked`, no commit; residual still-staged after restore → `setBlocked`, no commit; `stagedScratchPaths` helper unit.

## 3. Mirror, validate, CI

- [x] 3.1 After any `core/` edits, run `node scripts/build.mjs` and include regenerated `plugin/` in the same commit.
- [x] 3.2 Run `openspec validate pre-merge-archive-challenge-response-scratch` (and `openspec validate --all` as needed) until clean.
- [x] 3.3 Run `npm run ci` from the repo root and fix failures until green.
