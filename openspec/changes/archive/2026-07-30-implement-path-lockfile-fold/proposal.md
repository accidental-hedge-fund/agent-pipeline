## Why

After implement succeeds and HEAD advances, leftover lock-file side-effects
(`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`) are not folded into HEAD
before the format/test gates. The fix path already folds them via
`includeLockfileSideEffects` (#358). Implement salvage only runs when HEAD did
**not** advance, so a finished implement that leaves `?? package-lock.json` hard-
fails the testgate pre-dirty check with **0 fix attempts** and a human hold —
observed on #674 / run `674-2026-07-30T17-32-26-856Z`. The block copy also
misattributes that pre-dirty stop as “test/build gate failed after 0 fix
attempt(s)” even when the test command never ran.

## What Changes

- On the **implement / post-implementation** path (same place that leads into
  `runFormatAndTestGates` / `resumeFromImplementing`), call the existing lockfile
  side-effect fold used by fix (`includeLockfileSideEffects` / #358) so recognized
  uncommitted lock files are amended into HEAD **before** format/test gates.
- Keep the dirty-tree trust model for **non-lock** dirt unchanged.
- When the testgate fails solely on the pre-dirty (or post-run dirty) check — i.e.
  the test/build command never entered the fix loop — the operator-facing block
  reason MUST NOT claim “failed after N fix attempt(s)” / that the repo command
  is still failing; it must distinguish dirty-tree refusal from exhausted
  test/build fix attempts.
- Add seam-based regression coverage: implement-shaped HEAD advance + uncommitted
  lock → fold runs and pre-dirty does not see the lock as dirt (test bites without
  the fold); and dirty-only failure messaging does not use the exhaustion wrapper.
- Edit `core/`, regenerate `plugin/` via `node scripts/build.mjs` in the same
  change. No auto-merge.

## Capabilities

### New Capabilities

- `implement-commit-lockfile-inclusion`: After implement (and any post-implementation
  resume that runs format/test gates on an implementing worktree), fold uncommitted
  recognized lock-file side-effects into HEAD the same way the fix path does
  (#358 / `fix-commit-lockfile-inclusion`), so gates certify a worktree free of
  lock-file dirt without minting a separate commit.

### Modified Capabilities

- `test-build-gate`: Operator-facing block wording for pre-run / dirty-tree
  failures must remain distinct from the “failed after N fix attempt(s)” wrapper
  used when the test/build command actually ran and fix attempts were charged or
  exhausted. Dirty-tree blocks already return `attempts: 0` and a clear
  `blockReason`; the formatter that wraps gate results for GitHub blockers must
  not mislabel them as test-command exhaustion.

## Acceptance criteria

- [ ] After implement-shaped work that advanced HEAD and left an uncommitted
      recognized lock file (`package-lock.json` / `yarn.lock` / `pnpm-lock.yaml`
      at any depth), the post-implementation path folds that lock into HEAD before
      format/test gates; the testgate pre-dirty check does not observe that lock as
      dirt.
- [ ] The fold reuses the same recognized-lock rules and amend-no-edit behavior as
      the fix path (#358): only lock basenames are staged; commit message and
      `Issue:` / `Pipeline-Run:` trailers are preserved; no separate lock-only
      commit is created.
- [ ] Non-lock uncommitted paths are not auto-included; they still trip the
      existing pre-gate dirty block.
- [ ] When no lock-file dirt is present, implement post-implementation behavior is
      unchanged (no amend, no extra commit).
- [ ] A regression test drives implement-shaped HEAD advance + uncommitted lock
      and asserts fold before gates; the test **bites** without the fold (pre-dirty
      would still see the lock, or the fold seam is never invoked).
- [ ] When the testgate fails solely because the worktree is dirty before the
      command runs (command never started; attempts 0), the operator-facing block
      reason does **not** claim “Test/build gate failed after N fix attempt(s)” or
      that “the repo's own test/build command is still failing.”
- [ ] Dirty-tree block still names uncommitted paths (existing path disclosure
      retained).
- [ ] Unit tests use injectable deps only (no real git/network/subprocess for the
      new paths); `core/` changes are mirrored with `node scripts/build.mjs`;
      `openspec validate` and `npm run ci` pass.

## Impact

- `core/scripts/stages/planning.ts` (`resumeFromImplementing` and/or the immediate
  post-implement handoff before format/test gates) — call site for
  `includeLockfileSideEffects`.
- Possibly a thin shared helper if both fix and implement should share one
  “before gates” fold invocation pattern; prefer reusing
  `core/scripts/lockfile-side-effects.ts` without duplicating lock recognition.
- `core/scripts/testgate.ts` — `testGateBlockReason` (and/or a dirty-tree flag on
  `TestGateResult`) so dirty-only failures are not wrapped as fix exhaustion.
- `core/test/` — implement-path fold regression + dirty-block messaging regression.
- Living specs: new `implement-commit-lockfile-inclusion`; delta on
  `test-build-gate`.
- Regenerated `plugin/` via `scripts/build.mjs`.
- Does **not** change non-lock dirty trust, auto-merge, #718 capacity handling, or
  operationally unblock #674 by itself (though this class of hold should stop
  recurring).
