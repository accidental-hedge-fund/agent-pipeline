## 1. Base-sync before archive

- [ ] 1.1 In `maybeArchiveOpenspec` (`core/scripts/stages/pre_merge.ts`), before running
      `openspec archive`, fetch `origin` and fast-forward the worktree branch to
      `origin/<branch>` (reuse the existing `gitInWorktree` seam; `branch` is
      `branchName(issueNumber, wt.slug)`).
- [ ] 1.2 Capture the reviewed/pushed head SHA (`origin/<branch>` after fetch) and the
      worktree `HEAD` SHA as `archiveBase`.

## 2. Base-equality gate

- [ ] 2.1 After the sync attempt, compare worktree `HEAD` to `origin/<branch>`. If they
      are equal, proceed to archive/commit as today.
- [ ] 2.2 If they are not equal (fast-forward impossible / true divergence), block with
      `setBlocked` and a reason that names both SHAs: "archive base `<archiveBase>` !=
      reviewed head `<reviewedHead>`". Record the gate decision (`recordDecision("fail", …)`).
      Do not run `openspec archive`, commit, or push.

## 3. No-force-push guarantee

- [ ] 3.1 Keep the existing block-on-non-fast-forward-push behavior; ensure no code path
      adds `--force` / `--force-with-lease` to the archive push.
- [ ] 3.2 Add an inline comment documenting that a non-fast-forward archive push is a
      block signal, never a force-overwrite, and cite #579.

## 4. Tests (co-located, via `AdvancePreMergeDeps` seam — no real network/git)

- [ ] 4.1 Behind-remote sync: worktree `HEAD` is an ancestor of `origin/<branch>`; assert
      the step fetches + fast-forwards, archives on the reviewed head, and the resulting
      push is fast-forwardable (no block, no force).
- [ ] 4.2 Diverged base: worktree `HEAD` and `origin/<branch>` share only an older
      merge-base (fast-forward impossible); assert the step blocks with the
      "archive base != reviewed head" diagnostic and performs no push and no force push.
- [ ] 4.3 Already-in-sync (regression-guard): worktree `HEAD` already equals
      `origin/<branch>`; assert behavior is unchanged (archive → commit → normal push).
- [ ] 4.4 Prove each test bites — it fails against the pre-fix code.

## 5. Mirror + gate

- [ ] 5.1 `node scripts/build.mjs` and commit the regenerated `plugin/`.
- [ ] 5.2 `openspec validate openspec-archive-base-sync` passes; `npm run ci` green.
