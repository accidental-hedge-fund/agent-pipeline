## 1. Pre-merge auto-fix salvage

- [ ] 1.1 In `core/scripts/stages/pre_merge.ts` (`performPreMergeAutoFix`), before the
      `git reset --hard` rollback on the `!result.success` and `hasUncommitted || !hasNewCommit`
      branches, attempt `trySalvageUncommittedWork` scoped to the "no new commit + dirty worktree"
      case only.
- [ ] 1.2 When salvage produces a commit, route it through the existing amend-to-`PRE_MERGE_AUTOFIX_PREFIX`
      + push flow so the one-attempt bound detects it and the push targets the PR head.
- [ ] 1.3 Preserve the fail-closed rollback + `error` return when the worktree is genuinely clean
      (nothing salvaged) and when a new commit exists but extra dirt remains (out of scope).
- [ ] 1.4 Confirm the pre-merge review-SHA gate re-reviews the salvaged/pushed head (no bypass).

## 2. Implement-stage failure/timeout salvage

- [ ] 2.1 In `core/scripts/stages/planning.ts` implementing path, on `!result.success` attempt
      `salvageIfNoNewCommit` / `trySalvageUncommittedWork` before the harness-failure block.
- [ ] 2.2 On successful salvage, fall through to the existing commit-check / test-gate verification
      instead of returning the harness-failure block.
- [ ] 2.3 On a failed salvage attempt, thread the `failureReason` into the block comment (mirror the
      `#521` disclosure already used on the success-path no-commit block).

## 3. Gate-fix prompt single-turn discipline

- [ ] 3.1 Add the committing-only single-turn discipline paragraph (matching `implementing.md`) to
      `core/scripts/prompts/test_fix.md`, `eval_fix.md`, and `visual_fix.md`.
- [ ] 3.2 Add a `prompt-loader.test.ts` assertion per prompt that fails if the discipline text is
      removed.

## 4. Tests

- [ ] 4.1 Add a biting unit test for the pre-merge salvage path (no-commit dirty worktree →
      salvaged, prefix-amended, pushed; fails against the pre-change reset-and-discard).
- [ ] 4.2 Add a biting unit test for the implement-failure salvage path (crash/timeout dirty
      worktree → salvaged before block; fails against the pre-change block-without-salvage).
- [ ] 4.3 Add the gate-fix prompt discipline assertions and prove they bite (removing the text fails
      the test).

## 5. Mirror and gate

- [ ] 5.1 Regenerate the mirror: `node scripts/build.mjs`.
- [ ] 5.2 Run `npm run ci` from repo root and confirm green (`ci:core`, `build.mjs --check`,
      install-smoke, `openspec validate --all`).
