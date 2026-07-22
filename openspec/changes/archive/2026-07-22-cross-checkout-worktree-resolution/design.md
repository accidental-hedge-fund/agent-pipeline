# Design — cross-checkout managed-worktree resolution (#472)

## Context

Three code paths currently answer "is this record a pipeline-managed worktree?" and they do
not agree:

| Site | Root used | Effect from a linked checkout |
| --- | --- | --- |
| `listOnDisk` → `parseWorktreePorcelain` | `<first porcelain worktree>/<worktree_root>` (the **main** checkout) | worktrees under a linked checkout's root get `underManagedRoot: false` |
| `removeWorktreeForIssue` candidate filter | `underManagedRoot`, else `path.resolve(cfg.repo_dir, cfg.worktree_root)` | rejects the record → `no worktree found` |
| `sweepMergedWorktrees` fallback guard | same pattern | never sweeps a cross-checkout worktree (safe, but wrong) |

`git worktree list --porcelain` is already common-dir-wide: run from any linked checkout it
prints the same set, main worktree first. So the information needed to fix this is *already
in the data we parse* — we are throwing away all but one entry when computing the root.

## Decision 1: The managed root is a *set*, derived from the porcelain listing

For a porcelain listing enumerating checkouts `W₁ … W_k` (W₁ = main), the managed-root set is

```
{ path.resolve(Wᵢ, cfg.worktree_root) : i ∈ 1..k }
```

De-duplicated (an absolute `worktree_root` collapses every checkout to one root, which is
correct and desirable).

Rationale:

- **Common-dir-scoped by construction.** The listing is what Git itself considers registered
  for this common directory, so "discoverable from any linked checkout" is structural, not a
  heuristic. No `--git-common-dir` plumbing and no path-prefix guessing is needed.
- **Strictly a superset of today's root**, and identical to it for a single-checkout repo, so
  the no-regression criterion is a property of the construction rather than something tests
  must chase.
- **Ordering-independent.** The set does not depend on which checkout is `cfg.repo_dir`, which
  is exactly the invariant #472 is missing.

### Rejected alternatives

- *Match any worktree on a `pipeline/<N>-<slug>` branch, anywhere.* Simplest, and it would
  fix the report — but it makes a developer's own checkout of a pipeline branch deletable.
  The issue's acceptance criteria forbid exactly this.
- *Resolve the common dir and treat `<common-dir>/..` as the one true root.* Wrong for bare
  and relocated common dirs, and it still assumes a single root.
- *Persist the created worktree path in run state and read it back at removal time.* Only
  works for worktrees created after this change; the reported worktree (and every existing
  one) has no such record. State would also drift from Git, which is the authority here.
- *Scan the filesystem for `pipeline-*` directories.* Reintroduces the "similarly named
  directory" hazard the issue explicitly rules out.

## Decision 2: Identity rules are untouched

`parseWorktreePorcelain` keeps both identity paths exactly as they are — branch
`pipeline/<N>-<slug>` when present, and the `pipeline-<N>-<slug>` directory-name fallback
**only** for records with no branch line (detached HEAD, #223). Only the root comparison
becomes set membership. A record still must be *Git-registered* to exist in the listing at
all, so the "never delete a merely similarly named directory" criterion holds by
construction.

Signature: `parseWorktreePorcelain(stdout, worktreeRoots: string | string[])`. Accepting the
existing single-string form keeps the many existing call sites and tests compiling and
meaningful; internally it normalizes to a resolved, de-duplicated array.

## Decision 3: Removal selects from the managed set and fails closed on ambiguity

`removeWorktreeForIssue` drops its `path.resolve(cfg.repo_dir, cfg.worktree_root)` fallback
and instead collects **all** records with `issueNumber === N && underManagedRoot`:

- 0 matches → existing not-found result, error extended to name the searched roots.
- 1 match → proceed into the unchanged #296 safety ladder (dirty → local-only-commit tiers →
  remove), using `rec.path` and `rec.branch` as it already does.
- ≥2 matches → refuse: `{ removed: false, dirty: false, branch: null, worktree: null, error: … }`
  naming every candidate path. No `git` mutation is attempted.

Ambiguity is refused rather than resolved by a tie-break (e.g. "prefer the invoking
checkout's root") because both candidates are real managed worktrees holding real work; a
silent policy choice here deletes one of them. Fail-closed with an actionable list is the
behavior the issue asks for.

Records with `underManagedRoot === undefined` (constructed directly by a test seam, never by
the parser) keep the current fallback semantics: compare against the resolved root set. This
preserves the injectable-deps test pattern.

## Decision 4: The removal `git` invocations stay rooted at `cfg.repo_dir`

`git -C <any checkout> worktree remove <absolute path>` and `git -C <any checkout> branch -D`
operate on the shared common directory, so removing a worktree registered under a *different*
checkout works from the invoking one without change. Only discovery was broken; the mutation
surface is already common-dir-correct. This keeps the diff off the destructive path.

## Decision 5: One resolver, all listing callers

`listOnDisk` computes the root set once per call and hands it to the parser, so
`getForIssue`, `getOnDiskForIssue`, and `sweepMergedWorktrees` inherit consistent
classification without their own root math. This does mean sweep can now recognize a
cross-checkout worktree as managed — intended: it is a pipeline-managed worktree, and sweep's
merged-PR precondition and dirty checks are unchanged, so nothing becomes removable that was
not already removable had it lived under the main root.

## Risks

- **Widened sweep surface** (Decision 5) is the only behavior change outside removal. Bounded
  by: the record must be Git-registered, on/derived from a `pipeline/<N>-<slug>` identity,
  under a root of a registered checkout, and satisfy sweep's existing merge + cleanliness
  gates. Covered by an explicit sweep scenario.
- **Non-issue: shared-root collapse.** If `worktree_root` is configured absolute, every
  checkout maps to one root and two checkouts could genuinely produce two records for one
  issue only by path collision — impossible, since the paths would be identical and Git
  registers a path once. The ambiguity guard is therefore reachable only in the genuine
  two-roots case.

## Testing

All tests drive `parseWorktreePorcelain` / `removeWorktreeForIssue` with porcelain-string
fixtures and fake `RemoveWorktreeDeps` — no real git, network, or filesystem mutation, per
the repo's dependency-seam convention. The linked topology is expressed purely as a fixture:

```
worktree /repo
branch refs/heads/main

worktree /orchestration
branch refs/heads/goal-loop

worktree /orchestration/.worktrees/pipeline-7-fix-thing
branch refs/heads/pipeline/7-fix-thing
```

with `cfg.repo_dir = "/repo"`. Bite checks: reverting to the single main root reproduces
`no worktree found for issue #7`; dropping the ambiguity guard makes the two-candidate
fixture perform a removal.
