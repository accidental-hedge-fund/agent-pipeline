## Why

During #568's own pipeline run (2026-07-24) pre-merge blocked with "push failed
after archive". The root cause is not a transient push flake — it is a correctness
hole in the OpenSpec archive step:

- The reviewed, clean-approved head was `dd25659` (the full 244-line fix, pushed and
  approved by review-2 at 18:41).
- Pre-merge then created the archive commit `c5bd7b9` on top of `c155967` (the *fix-2*
  commit) — i.e. against a **stale local worktree base** that predated `dd25659`, not
  on top of the reviewed/pushed head.
- `c5bd7b9` and `dd25659` are siblings off `c155967` (merge-base confirms true
  divergence), so the push was correctly rejected non-fast-forward. **Had the engine
  retried with `--force`, it would have silently discarded the entire reviewed fix and
  shipped a merge candidate containing only the archive.**

`maybeArchiveOpenspec` (`core/scripts/stages/pre_merge.ts`) runs `openspec archive`,
commits, and `git push origin <branch>` from the worktree's local `HEAD` without ever
verifying that `HEAD` matches the reviewed PR head, and without fetching/syncing the
branch first. Whenever the local worktree is behind `origin/<branch>` (a fix pushed
from a different checkout — related class #547), the archive is built on the wrong base
and the only way a push could "succeed" is a data-losing force. Today the push simply
fails and blocks, but the safe base is never established, so the block is unactionable
without the manual remediation that was actually used (reset to the reviewed SHA, re-run
archive, fast-forward push).

## What Changes

- **The archive base is pinned to the reviewed/pushed PR head.** Before running
  `openspec archive`, the pre-merge archive step SHALL sync the worktree to
  `origin/<branch>` (fetch, then fast-forward the branch) so the archive commit is
  built on top of the current remote head — the head review approved and CI last ran
  against — never a stale local base.
- **A base-vs-head equality gate precedes the archive commit.** If, after the sync
  attempt, the worktree `HEAD` still does not match the reviewed/pushed head
  (`origin/<branch>`), the step SHALL block with a precise diagnostic naming both SHAs
  ("archive base `<x>` != reviewed head `<y>`") rather than committing/pushing an
  archive that could only push via force.
- **Force push is prohibited as a reconciliation path.** The archive step SHALL NOT
  `git push --force`/`--force-with-lease` to reconcile a divergence between the archive
  commit and the remote head. A non-fast-forward push is a signal to block, never to
  overwrite the reviewed head.
- The freeform (non-OpenSpec) path and repos without an `openspec/` workspace are
  unaffected; this only tightens the OpenSpec archive step already gated by
  `openspec.isActive`.

## Acceptance Criteria

- [ ] Before committing the OpenSpec archive, the pre-merge archive step fetches and
      fast-forwards the worktree to `origin/<branch>`, so the archive commit's parent is
      the current remote head.
- [ ] The archive commit is created on top of the reviewed/pushed PR head, never a
      stale local base whose merge-base with the remote head is an ancestor of both.
- [ ] When the worktree `HEAD` cannot be made equal to `origin/<branch>` (e.g. a
      fast-forward is impossible because local and remote have diverged), the step blocks
      with a diagnostic naming the archive base SHA and the reviewed-head SHA and does
      **not** attempt a push.
- [ ] The archive step never issues a force push (`--force` / `--force-with-lease`) to
      resolve a divergence; a non-fast-forward push result blocks instead.
- [ ] Regression test: given a worktree whose `HEAD` is behind `origin/<branch>`, the
      archive step syncs to `origin/<branch>` before committing, producing a
      fast-forwardable push (the archive commit descends from the reviewed head).
- [ ] Regression test: given a worktree `HEAD` that has genuinely diverged from
      `origin/<branch>` (a fast-forward is impossible), the step blocks with the
      "archive base != reviewed head" diagnostic and performs no push and no force push.

## Capabilities

### Modified Capabilities

- `openspec-integration`: the finalize/archive step gains a base-sync + base-equality
  precondition and an explicit no-force-push constraint, so the archive commit is always
  built on the reviewed/pushed head instead of a stale local worktree base.

## Impact

- `core/scripts/stages/pre_merge.ts` — `maybeArchiveOpenspec`: add the fetch +
  fast-forward-to-`origin/<branch>` sync and the base-vs-reviewed-head equality gate
  before the archive commit; keep the existing block-on-non-fast-forward-push behavior
  and add an explicit assertion that no force push is ever issued.
- `core/test/` — new regression tests via the existing `AdvancePreMergeDeps` seam
  (worktree/git fakes) covering the behind-remote sync path and the diverged-block path.
- Generated mirror `plugin/` regenerated via `node scripts/build.mjs`.
- No change to the never-merge boundary, the review-SHA gate's internal-commit
  classification, or the freeform path.
