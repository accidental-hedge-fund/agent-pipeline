## Why

The OpenSpec authoring step (spec-first planning) records `osAuthorHeadBefore`, runs the
planning harness, then — when the harness produced **no new commit** but left work uncommitted —
salvages the leftover via `salvageIfNoNewCommit` → `trySalvageUncommittedWork` →
`salvageUncommittedWork`. That salvage path stages **everything** with
`git add -A -- :(exclude)node_modules`. Immediately afterward, the authoring guard
(`verifyHarnessCommits` with `allowPattern: /^openspec\//`) rejects any salvage commit that
touches a non-`openspec/` file:

```
OpenSpec authoring step committed files outside `openspec/` — only intent files may be committed at this stage
```

This is reachable whenever the harness leaves work uncommitted. The reported trigger (#301) is
Codex's `--sandbox workspace-write`: Codex writes planning notes to `tasks/todo.md`, then its own
`git add openspec/changes/...` fails on the worktree's `.git/.../index.lock`, so the harness
exits with **no commit** and a worktree dirty with both the authored `openspec/changes/<id>/`
change *and* the `tasks/todo.md` notes. Salvage then stages both, and the authoring guard blocks —
requiring manual reset/re-run to recover.

The salvage path and the authoring guard **disagree about what is committable** at this stage: the
guard enforces "only `openspec/`", but the salvage that feeds it stages all changes. The existing
test `core/test/salvage-harness-work.test.ts:154` already documents this — a salvage commit passes
the authoring gate only when *every* file is under `openspec/`, and blocks when stray app code is
present. That stray-file block is exactly issue #321.

## What Changes

- The salvage path (`salvageUncommittedWork` / `trySalvageUncommittedWork` /
  `salvageIfNoNewCommit`) gains an **optional staging scope** (a git pathspec). When provided,
  both the dirtiness check (`git status --porcelain`) and the staging (`git add`) are restricted
  to that scope.
- The OpenSpec authoring call site in `planning.ts` passes the scope `openspec/` so a salvage at
  that stage stages and commits **only** `openspec/` changes — never tracked-file modifications
  outside `openspec/` such as `tasks/todo.md`. This aligns the salvage scope with the authoring
  guard's `allowPattern` so a salvaged authoring commit satisfies the guard instead of tripping it.
- When the *only* uncommitted changes are outside `openspec/` (no change authored on disk), the
  scoped salvage creates no commit and the stage falls through to its **existing** "produced no
  change under `openspec/changes/`" block — the correct, clearer outcome — rather than the
  path-constraint block.
- The scope parameter is optional and **defaults to today's unscoped behavior**
  (`git add -A -- :(exclude)node_modules`), so the implement, fix-round, and test-fix salvage call
  sites are byte-for-byte unchanged.

This is a root-cause fix at the salvage/guard layer: it is independent of *why* the harness left
work uncommitted (sandbox lock today; a harness crash tomorrow). Tracked modifications outside
`openspec/` are left uncommitted in the worktree — they are **not** discarded (no `git restore`).

## Capabilities

### Modified Capabilities

- `harness-uncommitted-salvage`: the salvage path SHALL accept an optional staging scope that
  restricts both the dirtiness check and staging; the OpenSpec authoring salvage SHALL be scoped to
  `openspec/`; non-authoring salvage SHALL retain the unscoped default.

## Impact

- `core/scripts/salvage-harness-work.ts` — thread an optional `scope` pathspec through
  `salvageUncommittedWork` / `trySalvageUncommittedWork`; scope the status check and the
  `gitAddAll` pathspec when present.
- `core/scripts/stages/planning.ts` — `salvageIfNoNewCommit` forwards an optional scope; the
  OpenSpec authoring call site (`salvageIfNoNewCommit(..., "OpenSpec authoring", osAuthorHeadBefore)`)
  passes `openspec/`.
- `core/test/salvage-harness-work.test.ts` — new scoped-salvage regression tests (the existing
  stray-file authoring-gate test gets its scoped counterpart).
- `plugin/` mirror — regenerated after the `core/` change (`node scripts/build.mjs`).

## Acceptance Criteria

- [ ] When the OpenSpec authoring harness leaves an uncommitted `openspec/changes/<id>/` change
  alongside a modified `tasks/todo.md`, the salvage commit contains only `openspec/` files and
  `tasks/todo.md` remains uncommitted in the worktree.
- [ ] The authoring path-constraint guard (`allowPattern: /^openspec\//`) passes on that salvage
  commit and the stage advances to plan-review — it does NOT block with "OpenSpec authoring step
  committed files outside `openspec/`".
- [ ] When the only uncommitted change is `tasks/todo.md` (no `openspec/changes/<id>/` authored on
  disk), the scoped salvage creates no commit and the stage blocks with the existing "produced no
  change under `openspec/changes/`" message — not the path-constraint message.
- [ ] The implement / fix-round / test-fix salvage call sites are unchanged: with no scope they
  still stage all changes via `git add -A -- :(exclude)node_modules`, and a non-`openspec/` file
  (e.g. `core/scripts/foo.ts`) is still included in those salvage commits.
- [ ] A regression test injects a worktree with both an `openspec/` change and an out-of-scope
  tracked modification, runs the scoped salvage, and asserts the out-of-scope file is excluded; the
  test fails (bites) if the scope is removed.
- [ ] `npm run ci` passes end-to-end (core tests + mirror `--check` + install smoke +
  `openspec validate --all`).
