## 1. Writeback deps seam for throwaway worktree

- [ ] 1.1 Extend `WritebackDeps` in `core/scripts/roadmap/writeback.ts` with injectable
      throwaway-worktree lifecycle (create/remove or a single higher-order helper) so
      unit tests never need real `git worktree`. Keep existing file/git/PR deps.
- [ ] 1.2 Wire the real implementation from the roadmap orchestrator / real-deps
      builder: linked worktree of the day-keyed branch (create branch from `baseBranch`
      when missing), scoped under a dedicated path prefix; always attempt removal in
      `finally`. Do not count this path as an issue-managed advance worktree.
- [ ] 1.3 Remove operator-checkout branch switching from the roadmap PR path: stop
      calling `gitSwitchBranch(repoDir, …)` (and stop committing into `repoDir`) for
      docs writeback. Delete or stop requiring the interface method if nothing else uses
      it on this surface.

## 2. openRoadmapPr behavior

- [ ] 2.1 Refactor `openRoadmapPr` so all docs file write, commit, and push run inside
      the throwaway worktree path, not the operator `repoDir`.
- [ ] 2.2 When `findPrByHead` finds an existing PR: compare rendered markdown to
      `docs/roadmaps/<repo>.md` **on the branch head** (via the worktree). If different,
      commit + push and return the existing PR URL; if identical, no commit and return
      the same URL. Never open a duplicate PR.
- [ ] 2.3 When no PR exists: create/update branch content in the throwaway worktree,
      commit, push, `createPr` as today (still no operator branch switch).
- [ ] 2.4 Replace the hardcoded commit message fossils (`Issue: #171`,
      `Pipeline-Run: 171/2026-06-17T04:37:16Z`) with a clean subject/body. Accept optional
      issue number + pipeline run id; when both are present, append trailers via
      `withTrailers` from `traceability.ts`; when either is missing, omit both trailers.

## 3. Regression tests

- [ ] 3.1 Replace the `roadmap-writeback.test.ts` regression that **requires**
      `gitSwitchBranch` with tests that assert writeback never switches/commits on the
      operator `repoDir` and that commit/push receive a distinct worktree path.
- [ ] 3.2 Add existing-PR refresh tests: content differs → commit+push, no `createPr`;
      content identical → no commit; comparison uses branch-head content from the
      worktree seam, not only the operator working tree.
- [ ] 3.3 Add commit-message shape tests: no fossil `#171` / fake run id strings; with
      both issue+run context → both trailers present; with partial/no context → no
      invented trailers.
- [ ] 3.4 Prove the isolation and fossil-message tests bite against the pre-fix behavior
      (or document the expected failure mode when temporarily reintroducing the old
      paths during implementation).

## 4. Mirror and CI gate

- [ ] 4.1 Run `node scripts/build.mjs` and include the regenerated `plugin/` mirror in
      the same change as any `core/` edits.
- [ ] 4.2 Run `npm run ci` from the repo root and fix failures until green (core tests,
      mirror `--check`, install smoke, openspec validate, conditional docs, scripts).
