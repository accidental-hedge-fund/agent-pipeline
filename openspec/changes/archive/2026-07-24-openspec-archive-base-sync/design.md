## Context

`maybeArchiveOpenspec` folds a completed OpenSpec change's deltas into the living specs
at pre-merge, then commits (`chore: archive OpenSpec change(s) for #N`) and pushes to the
PR branch so CI validates the finalized state. The archive commit is classified
pipeline-internal (`isPipelineInternalCommit`) so it does not invalidate the review-SHA
gate (#16).

The bug (#579): the step runs `openspec archive` against whatever the local worktree
`HEAD` happens to be, with no fetch and no check that `HEAD` matches the reviewed/pushed
PR head. When a fix commit was pushed from a *different* checkout than the pre-merge
worktree (related class #547), the worktree is behind `origin/<branch>`. The archive
commit is then built on the stale base, becomes a sibling of the reviewed head (shared
merge-base, true divergence), and the push is rejected non-fast-forward. The dangerous
counterfactual is a `--force` retry, which would discard the reviewed fix and keep only
the archive.

## Goals / Non-goals

- **Goal:** the archive commit's parent is always the reviewed/pushed head, and any
  irreconcilable divergence blocks with an actionable, SHA-named diagnostic.
- **Goal:** never issue a force push from the archive step.
- **Non-goal:** auto-resolving a genuine divergence (rebasing reviewed code onto a new
  base, cherry-picking). That is a human decision; the step blocks and surfaces it.
- **Non-goal:** changing the review-SHA gate, the internal-commit classification, or the
  freeform path.

## Decisions

### Decision 1 — Sync to `origin/<branch>` by fast-forward, not reset --hard

Fetch `origin`, then fast-forward the worktree branch to `origin/<branch>`
(`git merge --ff-only` / equivalent). Fast-forward is the correct primitive: it advances
the local branch to the remote head **only when the remote head descends from local
HEAD**, which is exactly the recoverable case (worktree merely behind). A `reset --hard`
to `origin/<branch>` would also "work" in the behind case but would silently mask true
divergence — the case that must block — by throwing away divergent local commits. Using
`--ff-only` makes the behind case succeed and the diverged case fail loudly, feeding the
equality gate.

The pre-archive worktree is already required to be clean (an existing guard blocks on any
dirty state before archive), so a fast-forward cannot clobber uncommitted work.

### Decision 2 — Base-equality gate reads the reviewed head from `origin/<branch>`

After the fetch, `origin/<branch>` *is* the reviewed/pushed head (the archive commit is
pipeline-internal, so review approved this SHA). The gate compares worktree `HEAD` to
`rev-parse origin/<branch>`. Equal → archive. Not equal → the fast-forward could not make
them equal, i.e. divergence — block with `archive base <HEAD> != reviewed head
<origin/branch>`. This uses `origin/<branch>` as the single source of truth for "the head
review approved", avoiding any dependence on a PR API field for the SHA (CLAUDE.md golden
rule #5: verify external shapes — here we sidestep gh `--json` entirely and read the ref).

### Decision 3 — No force push, ever, from the archive step

The existing push already blocks on a non-zero (non-fast-forward) exit. We keep that and
add an explicit no-`--force` invariant (comment + a test asserting the push args never
contain a force flag). A non-fast-forward push means the remote moved under us; the answer
is block-and-surface, not overwrite. This is consistent with surgical-fix discipline's
treatment of `git push --force` as a destructive operation.

## Ordering within `maybeArchiveOpenspec`

1. Resolve worktree, `isActive`, compute active candidates (unchanged).
2. Consistency guard #106 (unchanged).
3. Pre-archive cleanliness guard — clean tree required (unchanged; also a precondition for
   the safe fast-forward).
4. **New:** fetch `origin` + fast-forward branch to `origin/<branch>`.
5. **New:** base-equality gate — block on `HEAD != origin/<branch>` with the SHA-named
   diagnostic.
6. `openspec archive` each candidate → commit → push (unchanged), push still blocks on
   non-fast-forward and never forces.

## Risks

- A fetch/fast-forward failure (network) must fail closed (block), not silently skip the
  sync — otherwise the bug reappears. The block reason distinguishes a sync failure from a
  true divergence.
- Fast-forwarding the worktree changes `HEAD`; `preArchiveSha` capture (the no-run-recovery
  path) already happens earlier in `advancePreMerge` and is orthogonal, but implementation
  should confirm it records the post-sync reviewed head, not the stale pre-sync SHA.
