## 1. Shared active-change set helper

- [ ] 1.1 Inventory current candidate discovery (`maybeArchiveOpenspec` worktree diff + `changeDirExists`) vs residual guard (`unarchivedChangeIdsFromPrFiles` / PR paths) and document the dual-outcome paths in a short code comment or test fixture names (#626 skip→block, #675 partial multi-pass).
- [ ] 1.2 Single-source a pure helper (or tighten `unarchivedChangeIdsFromPrFiles` + a thin wrapper) that defines the shared active-change set from PR path lists; use it from both archive candidate resolution and `enforceOpenspecActiveChangeGuard`.
- [ ] 1.3 Add unit tests for the helper covering: single active id; multi active; active vs date-prefixed archive path; empty set; foreign/stacked id present only as active path.

## 2. Archive step coherence in pre_merge

- [ ] 2.1 Reorder `maybeArchiveOpenspec` so archive-base sync (fetch/FF to reviewed head) completes before final candidate resolution on a worktree.
- [ ] 2.2 Drive archive candidates from the shared active-change set (PR tip), intersected with post-sync worktree dir existence; fail closed when PR-active id has no dir after sync rather than `no-candidates`.
- [ ] 2.3 After archive CLI success, verify each id is no longer an active dir (or residual set); build `archivedIds` only from verified ids; record `pass` reason as verified ids only.
- [ ] 2.4 When residual active ids remain after archive attempts (partial multi-archive or archive no-op with clean status), block with `openspec-invalid` naming residual ids + `openspec archive` remedy — never record `skipped`/`no-candidates` if the pre-archive shared set was non-empty.
- [ ] 2.5 Ensure residual blocker text continues to name every still-active id and the push remedy (match living pre-merge contract).

## 3. Regression tests (must bite)

- [ ] 3.1 Fixture/test: one active change + injectable deps that reproduce current skip/`no-candidates` while PR residual is non-empty — assert fixed behavior forbids dual outcome (attempt archive or single block naming the id). Prove the test fails without the fix (or against a synthetic old path).
- [ ] 3.2 Fixture/test: two active changes where archive succeeds for only one — assert no `pass` listing both ids; assert coherent block or residual naming for the leftover (foreign/stacked shape).
- [ ] 3.3 Fixture/test: worktree behind reviewed head that introduces an extra active change — after sync path, id is a candidate (not silent `no-candidates`).
- [ ] 3.4 Keep existing pre-merge archive tests green (base sync, CLI unavailable, commit failure, true empty skip).

## 4. Mirror, validate, gate

- [ ] 4.1 If only OpenSpec artifacts / tests under `core/` changed as designed, regenerate `plugin/` via `node scripts/build.mjs` when `core/` is touched; include mirror in the same commit as core edits.
- [ ] 4.2 Run targeted pre-merge/openspec unit tests, then `npm run ci` from repo root (or at least `ci:core` + `openspec validate --all`) and fix failures.
- [ ] 4.3 Confirm `openspec validate pre-merge-openspec-archive-outcome-coherence` still passes after any task/spec wording tweaks during implementation.
