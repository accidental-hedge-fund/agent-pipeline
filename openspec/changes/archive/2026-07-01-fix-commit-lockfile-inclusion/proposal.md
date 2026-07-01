## Why

When a fix round's harness runs a package-manager command that rewrites a lock file
(`package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml`) — e.g. an `npm ci`/`npm install`
it runs while verifying its own work — the harness commits the source changes but leaves
the lock-file side-effects **uncommitted**. The existing salvage path (`harness-uncommitted-salvage`)
does not help: it only fires when the harness produced **no new commit** (`headBefore === headAfter`).
Here the harness *did* commit, so the leftover lock files sit dirty in the worktree.

That dirty state then trips the very next deterministic guard:
- the format gate's pre-flight dirty check (`runFormatGate`, "pre-existing uncommitted changes found in
  worktree before any format command ran"), and/or
- the test gate's pre-run dirty check (`testgate.ts`, "Worktree has uncommitted changes before the test
  gate ran").

The run blocks and a human must run `git add + commit` by hand to unblock — exactly what happened in the
#356 session, where the fix-1 harness's `npm ci` regenerated `core/package-lock.json` and a nested
`plugin/.../package-lock.json`.

## What Changes

- `core/scripts/stages/fix.ts`: after the fix harness produces its round commit — and after the existing
  no-new-commit salvage / commit-format / OpenSpec-delta checks, but **before** the format+test gates —
  the fix stage SHALL detect uncommitted **lock-file** changes and fold them into the round's HEAD commit
  (`git commit --amend --no-edit`), preserving that commit's message and `Issue:`/`Pipeline-Run:` trailers.
  No separate developer/fix commit is minted.
- A recognized lock file is any file named `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` at any
  directory depth in the worktree (so nested lock files such as `plugin/.../package-lock.json` are covered).
- **Only** lock files are auto-included. Any non-lock uncommitted path is left untouched and still hits the
  existing dirty-worktree block — this change does not broaden auto-inclusion to arbitrary leftover files.
- The lock-inclusion logic is placed behind an injectable dependency seam so its unit test uses fakes and
  performs no real git, network, or subprocess calls.

## Capabilities

### New Capabilities
- `fix-commit-lockfile-inclusion`: The fix-round commit step folds uncommitted lock-file side-effects into
  the round's commit so the worktree is clean before the format/test gates, without minting an extra commit
  and without auto-including any non-lock leftover file.

## Acceptance Criteria

- [ ] After a fix-round commit, `git status --porcelain` in the worktree reports **no** uncommitted
      `**/package-lock.json`, `**/yarn.lock`, or `**/pnpm-lock.yaml` change.
- [ ] When the fix harness commits source and leaves a lock-file change uncommitted, the fix stage stages
      that lock file and folds it into the round's HEAD commit, preserving that commit's message and its
      `Issue:`/`Pipeline-Run:` trailers — no separate commit is created.
- [ ] When the fix harness leaves **no** lock-file change, the fix stage's behavior is unchanged: no amend
      and no extra commit occur.
- [ ] A non-lock uncommitted file (e.g. a stray `core/scripts/foo.ts` edit) is **not** auto-included; the
      worktree stays dirty for that path and the existing pre-gate dirty block still fires.
- [ ] A regression test drives the case "fix harness committed source + left `core/package-lock.json`
      dirty": the commit step detects the dirty lock file, folds it into the round commit, and the worktree
      is clean of lock-file changes afterward. The test **bites** — with the inclusion step removed, the same
      input leaves the lock file uncommitted (worktree dirty).
- [ ] The lock-inclusion behavior is exercised through an injected dependency seam (fake git status/add/commit);
      the unit test performs no real git, network, or subprocess call.
- [ ] `node scripts/build.mjs` regenerates the `plugin/` mirror in the same change and `npm run ci` is green.

## Impact

- `core/scripts/stages/fix.ts` (+ its `AdvanceFixDeps` seam) and a small helper module, with a co-located
  test under `core/test/`.
- The generated `plugin/` mirror (regenerated via `scripts/build.mjs`).
- No changes to the state-machine edges, to how/when `npm ci` is invoked, or to the test gate's own
  post-run artifact-dirty certification blocks (those remain a separate path — see `design.md` Non-Goals).
