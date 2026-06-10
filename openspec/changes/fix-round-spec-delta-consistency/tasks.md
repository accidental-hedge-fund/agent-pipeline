## 1. Reframe the spec context section in the fix prompt

- [ ] 1.1 In `core/scripts/prompts/index.ts`, change `specContextSection` to render "This work **must stay consistent with** these requirement changes" instead of "This work **must satisfy** these requirement changes"
- [ ] 1.2 Confirm that `specContextSection` still returns `""` when spec context is absent (behavior unchanged)

## 2. Add spec-revision instruction to fix.md

- [ ] 2.1 In `core/scripts/prompts/fix.md`, add an OpenSpec-conditional block (rendered only when `{{spec_context}}` is non-empty) instructing the harness: if a finding's fix changes behavior described by the spec deltas, update the relevant `specs/**` files (and `tasks.md`) to match, then run `openspec validate <id>` and include the updated spec files in the same fix commit
- [ ] 2.2 Confirm the new block is positioned after the spec context placeholder and before the general "Do NOT change anything unrelated" line, so the conditional overrides the general prohibition only for spec-delta files

## 3. Add pre-merge consistency guard to maybeArchiveOpenspec

- [ ] 3.1 In `core/scripts/stages/pre_merge.ts`, before calling `openspec.archive(wt.path, id)`, add a consistency guard function that: (a) checks whether any developer/fix commit on the branch (since `origin/<base_branch>`) touched implementation files under `core/scripts/`; (b) checks whether the change's `specs/**` files are absent from the branch-diff paths; (c) reads the most recent review verdict stored in the worktree and checks whether any finding text contains language flagging spec divergence
- [ ] 3.2 When all three conditions are true, call `setBlocked` with a message naming the stale-delta condition and return `{ advanced: false, status: "blocked" }` without calling `openspec.archive`
- [ ] 3.3 Inject the guard's deps (branch-diff reader, verdict reader) via the existing `AdvancePreMergeDeps` seam so the guard is unit-testable without real git or filesystem calls

## 4. Write regression test

- [ ] 4.1 In `core/test/pre-merge.test.ts`, add a test: given a mock where (a) fix commits touched `core/scripts/foo.ts`, (b) the branch diff does not include `openspec/changes/<id>/specs/`, and (c) the latest review verdict contains a finding with "diverges from spec", `maybeArchiveOpenspec` returns `{ status: "blocked" }` and does NOT call the archive function
- [ ] 4.2 Add a complementary test: when the reviewer verdict contains no divergence finding, `maybeArchiveOpenspec` proceeds to archive normally (consistency guard does not false-positive)
- [ ] 4.3 Prove the regression test bites without the fix: temporarily remove the guard, confirm the test fails, then restore

## 5. Regenerate plugin mirror and verify CI

- [ ] 5.1 Run `node scripts/build.mjs` from the repo root to regenerate `plugin/` from the updated `core/` files
- [ ] 5.2 Run `npm run ci` from the repo root and confirm all checks pass (core tests, mirror-in-sync check, install smoke)

## 6. Commit

- [ ] 6.1 Commit all changed files (`core/scripts/prompts/fix.md`, `core/scripts/prompts/index.ts`, `core/scripts/stages/pre_merge.ts`, `core/test/pre-merge.test.ts`, regenerated `plugin/`) with message referencing #106
