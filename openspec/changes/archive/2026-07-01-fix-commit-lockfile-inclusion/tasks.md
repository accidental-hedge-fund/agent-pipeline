## 1. Lock-file inclusion helper

- [ ] 1.1 Add a helper (e.g. `includeLockfileSideEffects` in a new `core/scripts/lockfile-side-effects.ts`,
      mirroring the `SalvageDeps` seam pattern) that: reads `git status --porcelain` in the worktree,
      selects only paths whose basename is `package-lock.json`, `yarn.lock`, or `pnpm-lock.yaml` (at any
      depth), and — when at least one is dirty — stages only those paths and folds them into HEAD via
      `git commit --amend --no-edit`.
- [ ] 1.2 Return a result indicating whether an inclusion occurred (`{ included: false }` when no lock file
      is dirty) so the caller can log/branch. When no lock file is dirty, the helper performs no git write.
- [ ] 1.3 Expose injectable seams (`gitStatusPorcelain`, `gitAddPaths`, `gitAmendNoEdit`) with real git
      defaults, so unit tests inject fakes and make no real git/subprocess call.

## 2. Wire into the fix stage

- [ ] 2.1 In `advanceFix` (`core/scripts/stages/fix.ts`), after the no-new-commit salvage handling, the
      commit-format gate, and the OpenSpec spec-delta validation — and **before** `runFormatAndTestGates` —
      call the helper only when the round produced a commit (`headBefore && headAfter && headBefore !== headAfter`).
- [ ] 2.2 Add the helper (with its seams) to `AdvanceFixDeps` so tests can inject it; default to the real
      implementation.
- [ ] 2.3 Leave non-lock leftover files untouched — the helper's pathspec restricts staging to lock files,
      so an unrelated dirty file still reaches the existing format/test-gate dirty block unchanged.

## 3. Tests

- [ ] 3.1 Lock dirty after commit → helper stages the lock file and amends HEAD; assert `gitAddPaths` is
      called with only the lock path(s) and `gitAmendNoEdit` is called; the round's commit message/trailers
      are preserved (no new commit). Prove it bites: with the helper call removed, the fake worktree stays
      dirty on the lock file.
- [ ] 3.2 No lock change → helper is a no-op: `gitAddPaths`/`gitAmendNoEdit` are not called and no extra
      commit is produced (behavior-unchanged case).
- [ ] 3.3 Mixed dirt → only lock files are staged: given a dirty `core/package-lock.json` **and** a dirty
      `core/scripts/foo.ts`, assert only the lock file is staged/committed and `foo.ts` remains uncommitted.
- [ ] 3.4 Nested lock file (`plugin/.../package-lock.json`) is recognized and included.

## 4. Mirror + CI

- [ ] 4.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 4.2 `npm run ci` green from the repo root.
