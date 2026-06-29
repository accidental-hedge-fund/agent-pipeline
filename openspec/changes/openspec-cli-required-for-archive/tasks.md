## 1. Block the archive step on a missing CLI

- [ ] 1.1 In `core/scripts/stages/pre_merge.ts`, inside `maybeArchiveOpenspec`'s candidate
  loop, replace the `if (res.unavailable) { console.log(...); return null; }` branch with a
  blocking path: call `setBlockedFn(cfg, issueNumber, <reason naming the missing openspec CLI
  and the change id `id`>, "pre-merge", "openspec-invalid")` and return
  `{ advanced: false, status: "blocked", reason: \`openspec CLI unavailable (${id})\` }`.
- [ ] 1.2 Keep the existing early `if (candidates.length === 0) return null;` guard above the
  loop unchanged so the no-candidates path never reaches the CLI — the new block only triggers
  when there is real archive work.
- [ ] 1.3 Leave the CLI-success and `!res.success` (archive-failed) branches untouched — no
  behavior change on the CLI-present paths.

## 2. Regression tests (prove they bite)

- [ ] 2.1 In `core/test/pre-merge-convergence.test.ts`, add a test: build a config + deps
  where the worktree lookup returns an active worktree, `openspecIsActive` is true, the diff
  yields exactly one active candidate (`changeDirExists` true), and `openspecArchive` returns
  `{ unavailable: true, success: false, output: "" }`. Capture `setBlocked` calls via a fake.
  Assert the outcome is `{ status: "blocked" }` and `setBlocked` was called once with stage
  `"pre-merge"` and type `"openspec-invalid"`.
- [ ] 2.2 Add a no-regression test: same setup but the diff yields no active candidates;
  assert `maybeArchiveOpenspec` returns `null`, `openspecArchive` was never called, and
  `setBlocked` was never called. (May already be covered by the existing "returns null when
  diff is empty" test — extend/assert rather than duplicate.)
- [ ] 2.3 Prove 2.1 bites: temporarily restore `return null;` in the `unavailable` branch,
  run the suite, confirm 2.1 fails, then restore the fix.

## 3. Docs alignment

- [ ] 3.1 In `README.md` (OpenSpec section, the "the `openspec` CLI must be on PATH …"
  sentence near line 1069), replace "if it's missing the pre-merge gate is skipped
  (non-blocking)" with wording stating the CLI is required: when there is an active change to
  archive, a missing CLI blocks pre-merge with `openspec-invalid` (with an install hint),
  consistent with `doctor` and planning; repos with no active change to archive are unaffected.

## 4. Mirror + CI

- [ ] 4.1 Run `node scripts/build.mjs` from the repo root to regenerate the `plugin/` mirror;
  commit the regenerated mirror in the same change.
- [ ] 4.2 Run `npm run ci` from the repo root and confirm it is green end-to-end
  (`ci:core` → `build.mjs --check` → `ci:install-smoke`).
