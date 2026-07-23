# Design — salvage nested node_modules staging

## Context

`salvageUncommittedWork` (`core/scripts/salvage-harness-work.ts`) stages leftover harness work with:

```
git add -A -- :(exclude)node_modules            # unscoped default
git add -A -- :(exclude)node_modules <scope>     # scoped (openspec/)
```

`:(exclude)node_modules` is a **literal** pathspec (no `glob` magic): it matches only a
`node_modules` entry at the worktree root. In a monorepo the implementing agent runs `pnpm install`
inside the worktree and leaves nested installs at `apps/web/node_modules/.pnpm/…`. Those paths are
gitignored but not matched by the top-level-only exclusion, so `git add -A` enumerates them, git
refuses to add ignored paths without `-f`, the add exits non-zero, and `trySalvageUncommittedWork`
(correctly non-throwing) catches the error, logs it to `terminal.log`, and returns "nothing
salvaged". The caller then blocks with "produced no commits" while complete work sits uncommitted.

Two existing specs constrain this code:

- `worktree-staging-exclusions` **requires** an explicit exclusion pathspec on the salvage add, as a
  belt-and-suspenders guard for when `.git/info/exclude` is absent. So the fix must keep an explicit
  exclusion, not drop it.
- `harness-uncommitted-salvage` defines the salvage command, the parameterizable scope, and the
  `openspec/`-scoped variant — several requirements name the literal command string.

## Decision

**Make the exclusion depth-agnostic; keep it explicit.**

Replace `:(exclude)node_modules` with a pair of glob exclusions:

```
:(exclude,glob)**/node_modules        # the node_modules entry itself, at any depth
:(exclude,glob)**/node_modules/**     # everything under it, at any depth
```

`**/` with `glob` magic matches zero or more leading path components, so both a root
`node_modules` and a nested `apps/web/node_modules` (and their contents) are excluded. With the
nested paths excluded from the pathspec, `git add` never enumerates them, so it no longer refuses
the add — salvage succeeds and commits the real work.

Both exclusion members are kept because `**/node_modules/**` alone does not match the bare
`node_modules` directory/symlink entry (it requires a child path); `**/node_modules` covers the
entry itself. Together they exclude the entry and its subtree at any depth.

This is defined once as a shared constant in `salvage-harness-work.ts` and reused by both the
unscoped `SALVAGE_GIT_ADD_ARGS` and the scoped add args, so no call site hardcodes the pathspec and
future drift is avoided.

### Alternatives considered

- **Drop the exclusion entirely and rely on gitignore + `.git/info/exclude`.** The issue notes
  `git add -A` skips gitignored files natively, so in principle the exclusion is redundant. Rejected:
  `worktree-staging-exclusions` explicitly requires an explicit exclusion as a belt for when
  `.git/info/exclude` is absent/stale, and dropping it would regress that invariant. Keeping an
  explicit-but-depth-agnostic exclusion satisfies both specs.
- **`git add -A .` from the worktree root (no pathspec).** Also relies solely on gitignore and
  removes the belt; same rejection.
- **Add `-f` / force.** Wrong direction — it would stage ignored `node_modules`, violating the
  post-commit node_modules scan.

## Blocker disclosure

`trySalvageUncommittedWork` is intentionally total (a salvage failure must never make the run worse
than today's block). Today it swallows the failure to `terminal.log` and returns a boolean, so the
operator-facing blocker comment says only "produced no commits" — the salvage failure is invisible
without opening the raw log.

The change extends the helper's return to carry the caught `failureReason` alongside `salvaged`. The
no-commit block sites (planning implement + OpenSpec authoring, fix rounds, testgate/eval/visual
loops) thread that reason into their `doSetBlocked` comment. Total behavior is preserved: the helper
still never throws, and when there was no salvage attempt / a clean worktree / a successful salvage,
the blocker comment is byte-for-byte unchanged.

## Risks / notes

- Types are stripped, not checked (no `tsc`), so the extended return shape and the pathspec constant
  are backed by real runtime tests, not type guarantees.
- The `worktree-staging-exclusions` `.git/info/exclude` bootstrap and post-commit node_modules scan
  are unchanged; this change only touches the salvage staging pathspec and the blocker disclosure.
- Every change under `core/` requires regenerating the `plugin/` mirror (`node scripts/build.mjs`)
  in the same commit.
