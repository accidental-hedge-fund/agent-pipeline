# Tasks — cross-checkout managed-worktree resolution (#472)

## 1. Managed-root set resolver

- [ ] 1.1 In `core/scripts/worktree.ts`, add an exported pure function that takes the raw
      `git worktree list --porcelain` stdout and `cfg.worktree_root` and returns the resolved,
      de-duplicated set of managed roots — one `path.resolve(<checkout>, worktree_root)` per
      `worktree <path>` line.
- [ ] 1.2 Assert by unit test that the set is independent of which checkout is `cfg.repo_dir`
      and that a single-checkout listing yields exactly today's single root.

## 2. Parser matches against the root set

- [ ] 2.1 Widen `parseWorktreePorcelain`'s second parameter to `string | string[]`; normalize
      internally to a resolved, de-duplicated array.
- [ ] 2.2 Set `underManagedRoot` when the record's parent directory equals **any** root.
- [ ] 2.3 Leave both identity rules untouched: `pipeline/<N>-<slug>` branch match, and the
      directory-name fallback restricted to records with no branch line (#223).
- [ ] 2.4 Update `listOnDisk` to compute the root set via 1.1 and pass it through; delete the
      first-worktree-line-only derivation.

## 3. Cross-checkout removal discovery

- [ ] 3.1 In `removeWorktreeForIssue`, replace the single-record `find` with a collection of
      **all** records matching `issueNumber === N` and under a managed root; drop the
      `path.resolve(cfg.repo_dir, cfg.worktree_root)` recomputation.
- [ ] 3.2 Keep the `underManagedRoot === undefined` (test-injected record) fallback comparing
      against the resolved root set.
- [ ] 3.3 Zero matches → existing not-found result shape, error extended to name the roots
      searched.
- [ ] 3.4 Exactly one match → unchanged #296 ladder (dirty check → local-only-commit tiers →
      `--force` semantics → removal), driven from `rec.path` / `rec.branch`.
- [ ] 3.5 Two or more matches → refuse before any git mutation:
      `{ removed: false, dirty: false, branch: null, worktree: null, error }` naming every
      candidate path and directing the operator to remove the intended one explicitly.
- [ ] 3.6 Verify by inspection that no removal-path `git` invocation changed; they remain
      rooted at `cfg.repo_dir` against the shared common directory.

## 4. Consistency for the other listing callers

- [ ] 4.1 Confirm `getForIssue`, `getOnDiskForIssue`, and `sweepMergedWorktrees` inherit the
      resolver through `listOnDisk` with no root math of their own.
- [ ] 4.2 Confirm sweep's merged-PR and cleanliness preconditions are untouched for a
      cross-checkout record.

## 5. CLI diagnostics

- [ ] 5.1 Surface the ambiguity and extended not-found errors through `runRemoveWorktree` in
      `core/scripts/pipeline.ts` — text only; `--json` field set and exit-code rules unchanged.

## 6. Tests

- [ ] 6.1 `core/test/worktree.test.ts`: root-set resolution (multi-checkout, single-checkout,
      absolute `worktree_root` collapse) and `underManagedRoot` classification for a record
      under a linked checkout's root.
- [ ] 6.2 `core/test/worktree-remove.test.ts`: cross-checkout discovery + removal invoked from
      the primary checkout, and from a third unrelated linked checkout.
- [ ] 6.3 Negative: a `pipeline/<N>-<slug>` worktree registered under **no** managed root is
      not selected; no `removeWorktree` dep call is recorded.
- [ ] 6.4 Negative: an unregistered `pipeline-<N>-<slug>` directory is never selected.
- [ ] 6.5 Ambiguity: two managed records for issue N → refusal naming both paths, zero
      removal dep calls.
- [ ] 6.6 Regression parity: re-run the existing #296 outcome tests (clean, dirty-no-force,
      dirty-force, stale registration, not-found, `--json` shape, local-only-commit tiers)
      against a linked-checkout topology and assert identical result objects.
- [ ] 6.7 Sweep: a cross-checkout worktree is swept only when its merged-PR precondition holds.
- [ ] 6.8 Prove the tests bite — revert the root set to the main-worktree-only root and see
      6.2 fail with `no worktree found`; drop the 3.5 guard and see 6.5 delete a worktree.

## 7. Ship

- [ ] 7.1 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 7.2 `npm run ci` green from the repo root.
