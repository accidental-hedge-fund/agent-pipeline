# Resolve managed worktrees through Git's registered worktree set, not the invoking checkout (#472)

## Why

`pipeline N --remove-worktree` cannot find a Pipeline worktree that was created from a
*different linked checkout* of the same repository.

Observed on `comamitc/goal-loop` #7 (2026-07-21). goal-loop runs Pipeline from a required
linked orchestration worktree, so Pipeline created the issue worktree under that checkout's
relative worktree root:

```
/repo                                   ← primary checkout
/repo/.worktrees/                        (empty — nothing here for #7)
/orchestration                          ← linked worktree of the same common dir
/orchestration/.worktrees/pipeline-7-…  ← the managed worktree that actually exists
```

Cleanup was later invoked from the primary checkout. `git worktree list` showed the clean
Pipeline worktree, but Pipeline reported `no worktree found for issue #7`, and the operator
had to fall back to raw `git worktree remove`.

The defect is a **single-root assumption** about what "managed" means, applied in two places
that disagree with each other:

- `listOnDisk` (`core/scripts/worktree.ts`) derives one managed root from the **main**
  worktree (`<main>/<worktree_root>`) — the #223 fix — and `parseWorktreePorcelain` stamps
  `underManagedRoot` against that single root.
- `removeWorktreeForIssue` then filters candidates down to records with
  `underManagedRoot === true` (falling back to a root recomputed from `cfg.repo_dir`).

A worktree created from a linked checkout is under `<linked>/<worktree_root>` — neither
root. It is still parsed and identified (its `pipeline/7-<slug>` branch matches), so
`getForIssue` sees it, but the removal guard rejects it, and the operator gets a
not-found diagnostic for a worktree that plainly exists. Sweep classification is wrong for
the same reason, in the safe direction: a genuinely managed worktree is never recognized.

This is distinct from prior work. #296 / PR #298 added the targeted, safety-checked
per-issue removal but reconstructs the path from the invoking checkout. #155 handles a
nested directory *inside one checkout*. #223 fixed the "launched from a linked worktree,
worktree lives under the main root" direction only. None of them covers **two linked
worktrees of one Git common directory using different relative worktree roots**.

## What Changes

- **One shared resolution of the managed-root set.** A new resolver derives the set of
  pipeline-managed worktree roots from Git's own registered worktree state: for every
  checkout listed by `git worktree list --porcelain` (which is common-dir-wide, so it is
  identical from any linked checkout), the candidate root is
  `path.resolve(<checkout>, cfg.worktree_root)`. The main worktree's root — today's only
  root — remains in the set, so existing single-checkout topologies are byte-for-byte
  unchanged.
- **`parseWorktreePorcelain` matches against the root set.** `underManagedRoot` becomes
  true when a record's parent directory equals *any* candidate root, keeping the existing
  identity rules intact: a `pipeline/<N>-<slug>` branch identifies the record, and the
  directory-name fallback stays restricted to records with no branch line (detached HEAD).
  A developer-owned checkout of a pipeline branch outside every managed root is still
  `underManagedRoot: false`.
- **Removal discovers through that set and fails closed on ambiguity.**
  `removeWorktreeForIssue` selects the record whose `issueNumber` matches **and** which is
  under a managed root, with no `cfg.repo_dir`-derived recomputation. If more than one
  managed record matches issue N (e.g. the same issue worktree present under two checkouts'
  roots), removal is refused with a diagnostic naming every candidate path — no deletion,
  no guessing. Not-found keeps its existing message, extended to name the roots searched.
- **Every existing safety behavior from #296 is preserved unchanged**: dirty-worktree
  blocking, the local-only-commit tiers (`true` / `"unverifiable"` / `null`), the
  remote-branch checks, `--force` semantics, the JSON result shape, and the kill-switch
  bypass. Only *which record is selected* changes.

## Non-goals

- **No change to where worktrees are created.** Creation still places the worktree at
  `<invoking checkout>/<worktree_root>/pipeline-<N>-<slug>`. Existing worktrees are never
  silently relocated; this change makes them *findable*, not *moved*.
- **No change to branch naming** or to the `pipeline/<N>-<slug>` identity contract.
- **No broadening of deletion beyond Git-registered, managed-root Pipeline worktrees.** An
  unregistered directory that merely looks like `pipeline-<N>-<slug>`, and any
  developer-owned worktree outside every managed root, remain untouchable.
- **No weakening of the commit/dirty safety checks** to make cross-checkout removal
  succeed.

## Deferred (out of scope, follow-up)

The human comment on #472 reports a related defect from a supervised fuseiq-core run:
`pipeline run 95 --detach` invoked with cwd *inside* a pipeline-managed worktree was
accepted, and the run store was created under that worktree — a location destroyed at
finalize. Rejecting (or redirecting) a run whose resolved repo root is itself a managed
worktree is a change to **run acceptance**, not to worktree discovery/removal, and #472's
stated scope is explicitly discovery/removal only. The managed-root set this change
introduces is exactly the predicate such a guard needs, so it is left as a tracked
follow-up (sibling to #485, which covers the strays-created-before-validation half) rather
than folded in here.

## Acceptance criteria

- [ ] With a repository whose common dir has a primary checkout and a linked checkout, and a
      registered Pipeline worktree for issue N at `<linked>/<worktree_root>/pipeline-N-<slug>`
      on branch `pipeline/N-<slug>`, `removeWorktreeForIssue` invoked with `cfg.repo_dir` set
      to the **primary** checkout resolves that worktree and returns
      `{ removed: true, worktree: "<linked>/<worktree_root>/pipeline-N-<slug>", branch: "pipeline/N-<slug>", error: null }`.
- [ ] The same removal invoked from a **third** linked checkout (neither the primary nor the
      one that created the worktree) resolves the identical record.
- [ ] The managed-root set returned by the resolver contains, for a porcelain listing of K
      registered checkouts, exactly the K paths `path.resolve(<checkout>, cfg.worktree_root)` —
      including the invoking checkout's own root — and is independent of which checkout is
      `cfg.repo_dir`.
- [ ] A worktree on branch `pipeline/N-<slug>` registered at a path under **no** managed root
      (a developer's own checkout of the pipeline branch) is reported
      `underManagedRoot: false` and yields `removed: false` with a not-found error; no
      `git worktree remove` and no `git branch -D` is invoked.
- [ ] A directory named `pipeline-N-<slug>` that is **not** in `git worktree list --porcelain`
      output is never selected for removal, regardless of which root it sits under.
- [ ] When two managed records match issue N (one under each of two checkouts' roots),
      removal returns `removed: false`, `worktree: null`, and an error naming **both**
      candidate paths and directing the operator to remove the intended one explicitly; no
      removal operation of any kind is invoked.
- [ ] Not-found for issue N returns an error that names the issue and the managed roots that
      were searched, and invokes no removal operation.
- [ ] In a single-checkout repository, the resolved root set is the one existing root and
      every `removeWorktreeForIssue` outcome (clean removal, dirty-without-`--force`,
      dirty-with-`--force`, stale registration, not-found) matches pre-change behavior
      byte-for-byte in the returned result object.
- [ ] Dirty-worktree blocking, local-only-commit blocking (`true`), `"unverifiable"`
      soft-blocking without `--force`, hard-blocking on `null`, and the `--json` result shape
      are unchanged for a cross-checkout record — proven by the existing #296 test bodies
      re-run against a linked-checkout topology.
- [ ] `getForIssue` / `getOnDiskForIssue` / `sweepMergedWorktrees` consume the same resolver,
      so a cross-checkout worktree is classified identically by all listing callers; a sweep
      of a cross-checkout worktree still requires its merged-PR precondition.
- [ ] Regression tests bite: reverting the resolver to the single main-worktree root makes the
      cross-checkout discovery test fail with the `no worktree found for issue #N` error, and
      removing the ambiguity guard makes the two-candidate test delete a worktree.
- [ ] Tests construct the linked-worktree topology through injected porcelain fixtures and
      fake deps — no real `git`, network, or filesystem mutation.
- [ ] `npm run ci` is green, including the regenerated `plugin/` mirror.

## Capabilities

### New Capabilities
- `managed-worktree-resolution`: the pipeline-managed worktree root set is derived from
  Git's registered worktree list for the shared common directory, and every listing caller
  classifies records against that set.

### Modified Capabilities
- `worktree-per-run-removal`: `--remove-worktree` discovers the target through the managed-root
  set (cross-checkout capable) and fails closed on an ambiguous match.

## Impact

- `core/scripts/worktree.ts` — new managed-root resolver; `parseWorktreePorcelain` takes a
  root set; `listOnDisk` passes the resolved set; `removeWorktreeForIssue` drops the
  `cfg.repo_dir` root recomputation and gains the ambiguity guard.
- `core/scripts/pipeline.ts` — `runRemoveWorktree` diagnostics for the ambiguous case
  (result shape unchanged; `error` text only).
- `core/test/worktree.test.ts`, `core/test/worktree-remove.test.ts` — linked-topology
  fixtures and the negative/ambiguous cases.
- `plugin/` — regenerate via `node scripts/build.mjs`.
