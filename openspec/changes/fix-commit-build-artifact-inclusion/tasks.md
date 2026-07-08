## 1. Config: `build_command`

- [x] 1.1 Add a top-level optional `build_command` string to the config schema in
      `core/scripts/config.ts` (mirror `setup_command`: a bare shell string, run via `bash -c`). Document
      it as "Repo build command run after fix/auto-fix edits; its output is folded into the round commit so
      committed generated artifacts stay fresh."
- [x] 1.2 Thread `build_command` through the resolved config (`fileConfig.build_command`), the
      `pipeline.yml` renderer (a commented `# build_command:` example), and any config-validate/line-lookup
      surfaces that enumerate keys — matching how `setup_command`/`test_gate.command` are handled.
- [x] 1.3 Confirm the key is inert when absent: no default value, no auto-detection, no generic fallback.

## 2. Rebuild-and-fold helper

- [x] 2.1 Add a helper (e.g. `includeBuildArtifacts` in a new `core/scripts/build-side-effects.ts`,
      mirroring the `lockfile-side-effects.ts` seam pattern) that, given the worktree path and the declared
      build command: (a) returns a no-op result immediately when no command is declared; (b) runs the build
      command in the worktree; (c) on non-zero exit returns a failure result carrying the captured output;
      (d) on success stages any resulting worktree changes and folds them into HEAD via
      `git commit --amend --no-edit`, returning whether an amend occurred and which paths were folded.
- [x] 2.2 Guard the fold on a **clean post-commit worktree**: the caller invokes the helper only when the
      round produced a commit and the tree is clean, so any dirt observed *after* the build is attributable
      to the build. When the build produces no diff, perform no amend (SHA/message preserved).
- [x] 2.3 Expose injectable seams (a build runner, `gitStatusPorcelain`/`gitDirty`, `gitAddAll` scoped to
      the build output, `gitAmendNoEdit`) with real defaults, so unit tests inject fakes and make no real
      git/subprocess call. Truncate captured build output for block reasons via the existing output-cap
      helper.

## 3. Wire into the fix stage

- [x] 3.1 In `advanceFix` (`core/scripts/stages/fix.ts`), after the lock-file inclusion (#358) and **before**
      `runFormatAndTestGates`, call the helper only when a build command is declared, the round produced a
      commit (`headBefore && headAfter && headBefore !== headAfter`), and the worktree is clean.
- [x] 3.2 On build failure, `setBlocked` with an explicit build-failure reason and a distinct blocker kind
      (e.g. `build-failed`), and return `{ advanced: false, status: "blocked" }` — no amend, no advance.
- [x] 3.3 Add the helper (with its seams) to `AdvanceFixDeps`, defaulting to the real implementation; log a
      one-line note when artifacts are folded in.

## 4. Wire into the auto-fix (test-gate) path

- [x] 4.1 In the test-gate fix loop (`core/scripts/testgate.ts`), after an attempt's fix-harness commit
      passes the existing clean-tree / commit-format / trailer checks and **before** the test command
      re-runs, call the same helper when a build command is declared and the tree is clean.
- [x] 4.2 On build failure, return a blocking result with the explicit build-failure reason (distinct from
      the "test/build gate failed after N fix attempt(s)" message), without consuming further fix attempts
      dishonestly.
- [x] 4.3 Add the helper seam to the test-gate deps so tests inject a fake; default to the real
      implementation.

## 5. Tests

- [x] 5.1 Fix round edits source + build produces a `dist/` change → helper runs the build, stages the
      artifact, and amends HEAD; assert the amend is called, the round commit message/trailers are
      preserved, and no separate commit is created. Prove it **bites**: with the helper call removed, the
      fake worktree stays dirty / the artifact stays stale.
- [x] 5.2 No `build_command` declared → helper is a no-op: the build runner is never invoked, no amend
      occurs, and fix/auto-fix behavior is byte-for-byte unchanged.
- [x] 5.3 Build command exits non-zero → the round blocks with the explicit build-failure reason and no
      amend occurs (stale/broken artifacts are never committed).
- [x] 5.4 Idempotence → after the fold, a second build run against the committed source produces no diff
      (fake build runner asserts the second invocation yields an empty change set).
- [x] 5.5 Auto-fix path → a test-gate fix attempt commits source and the build produces an artifact change:
      assert it is folded into that attempt's commit before the test command re-runs.
- [x] 5.6 Unrelated pre-existing dirt → when the post-commit worktree is not clean, the helper does not run
      the build (or does not fold the unrelated path) and the existing dirty-worktree block still fires.

## 6. Mirror + CI

- [x] 6.1 `node scripts/build.mjs` to regenerate the `plugin/` mirror; commit it in the same change.
- [x] 6.2 `npm run ci` green from the repo root.
