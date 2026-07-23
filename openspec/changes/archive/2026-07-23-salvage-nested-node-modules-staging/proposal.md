## Why

The uncommitted-work salvage path (#131) stages harness leftovers with a **top-level-only**
node_modules exclusion:

```
git add -A -- :(exclude)node_modules
```

The `:(exclude)node_modules` pathspec is a literal, un-globbed match — it excludes only a
`node_modules` entry at the **worktree root**. In a monorepo the stray installs an implementing
agent leaves behind live at nested paths (`apps/web/node_modules/.pnpm/…`, created when the agent
runs `pnpm install` inside the worktree). Those nested paths fall outside the exclusion, so
`git add -A` enumerates them, git refuses to add gitignored paths without `-f`, the add exits
non-zero, and `trySalvageUncommittedWork` catches the error and returns "nothing salvaged". The run
then hard-blocks with "produced no commits" **even though complete, verifiable work is sitting in
the worktree** — turning a recoverable case (the class #486 addresses) into a hard block.

Observed three times in one day on PraxisIQ/fuseiq-core (engine v1.16.0): #101 fix-2, #102 and
#103 implementing.

Two compounding problems:

1. **The exclusion only matches the top level.** It must exclude `node_modules` at *any* nesting
   depth so nested installs never break the add.
2. **The salvage failure is invisible to the operator.** `trySalvageUncommittedWork` logs the git
   failure only to `terminal.log`; the blocker comment says just "produced no commits", hiding the
   real reason (the salvage add refused ignored paths). An operator cannot tell recoverable work
   exists without opening the raw log.

## What Changes

- **Depth-agnostic node_modules exclusion in the salvage staging command**
  (`core/scripts/salvage-harness-work.ts`). Replace the top-level-only `:(exclude)node_modules`
  pathspec with a depth-agnostic exclusion — `:(exclude,glob)**/node_modules` and
  `:(exclude,glob)**/node_modules/**` — that excludes a `node_modules` entry and its contents at
  any nesting depth. This applies to both the default (unscoped) staging args and the scoped
  (`openspec/`) staging args. `node_modules` is still never staged (the belt-and-suspenders
  invariant of `worktree-staging-exclusions` is preserved), and the add no longer trips over nested
  installs in a monorepo, so salvage succeeds and the real work is committed.
- **Surface the salvage failure reason in the no-commit blocker comment.** When a salvage attempt
  is made and its git operation fails, the captured failure reason SHALL be threaded into the
  subsequent no-commit blocker comment so the operator sees *why* nothing was salvaged (and that
  recoverable work may exist) without reading `terminal.log`. When no salvage was attempted or the
  worktree was genuinely clean, the blocker comment is unchanged.

## Capabilities

### Modified Capabilities
- `harness-uncommitted-salvage`: the salvage staging command excludes `node_modules` at any nesting
  depth (not only the worktree root), so salvage succeeds in monorepos with nested installs; and a
  failed salvage attempt discloses its failure reason in the no-commit blocker comment.
- `worktree-staging-exclusions`: the explicit salvage-staging node_modules exclusion pathspec is
  depth-agnostic rather than top-level-only.

## Acceptance Criteria

- [ ] With a dirty worktree whose only ignored cruft is a **nested** `apps/web/node_modules/.pnpm/…`
      install alongside real changed source files, the implement/fix/test-fix salvage produces a
      salvage commit containing the real source changes and the run advances — it does **not** block
      with "produced no commits".
- [ ] The salvage staging command excludes `node_modules` at **any** nesting depth; no path whose
      last-or-any component is `node_modules` (root or nested) is staged or committed by salvage.
- [ ] The salvage `git add` does not exit non-zero because of ignored nested `node_modules` paths;
      an existing nested `node_modules` directory no longer aborts the salvage.
- [ ] The scoped (`openspec/`) salvage path applies the same depth-agnostic node_modules exclusion
      and its existing scope behavior (stage only `openspec/`) is unchanged.
- [ ] When a salvage attempt is made and its git operation fails, the resulting no-commit blocker
      comment includes the salvage failure reason; when the worktree is clean or no salvage was
      attempted, the blocker comment is unchanged.
- [ ] A regression test bites: with a worktree mock containing a nested `node_modules` entry plus a
      real changed file, the fix produces a salvage commit with the real file and no `node_modules`
      path; reverting to the top-level-only pathspec (or dropping the exclusion) makes the test fail.
- [ ] A unit test covers the blocker-disclosure path: a salvage failure reason is surfaced into the
      block reason, and the clean/no-attempt case leaves the blocker comment unchanged.
- [ ] `npm run ci` passes (core tests, `plugin/` mirror sync, install smoke, `openspec validate --all`).

## Impact

- `core/scripts/salvage-harness-work.ts`: change `SALVAGE_GIT_ADD_ARGS` and the scoped add args to
  the depth-agnostic exclusion; capture and return the git failure reason from
  `trySalvageUncommittedWork` (in addition to today's `salvaged` boolean) so callers can disclose it.
- The no-commit block sites that call the salvage helpers (`core/scripts/stages/planning.ts`,
  `core/scripts/stages/fix.ts`, and the loop callers in `core/scripts/testgate.ts`) thread the
  captured salvage failure reason into their `doSetBlocked` blocker comment.
- Co-located tests: `core/scripts/salvage-harness-work.test.ts` (nested-node_modules staging,
  failure-reason capture) and the relevant stage/testgate tests (blocker disclosure).
- No config keys, CLI surface, state-machine edges, or review/SHA-gate contracts change. The
  `.git/info/exclude` bootstrap and post-commit node_modules scan from `worktree-staging-exclusions`
  are unchanged.
