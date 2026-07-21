# Tasks — pre-merge OpenSpec archive fail-closed (#467)

## 1. Reproduce first

- [ ] 1.1 Add a failing test in `core/test/` that replays the #464 shape: OpenSpec active,
      PR file list contains `openspec/changes/finding-level-reversal-matching/…`, archive step
      returns `null`, and `advancePreMerge` currently advances — assert it must block.
- [ ] 1.2 Add a failing test for the candidate probe: `gitInWorktree` fake returns exit ≠ 0 for
      `diff --name-only origin/main...HEAD`; assert `maybeArchiveOpenspec` blocks (today: `null`).
- [ ] 1.3 Confirm both tests fail on the current code (they must bite).

## 2. Head-side active-change guard

- [ ] 2.1 Add a pure helper (e.g. `unarchivedChangeIdsFromPrFiles(paths: string[]): string[]`)
      in `core/scripts/openspec.ts` computing active ids minus archived ids from a file list.
- [ ] 2.2 Unit-test the helper: active-only, archived-only, both, none, nested paths, `archive`
      id exclusion.
- [ ] 2.3 Call the guard in `advancePreMerge` after the archive step returns `null` and before
      the stage advances, using the existing `getPrDiff`/`diffFilePaths` seam; block with
      `setBlocked(..., "pre-merge", "openspec-invalid")` naming every remaining id and the
      `openspec archive <id>` remedy.

## 3. Fail-closed archive preconditions

- [ ] 3.1 Make the candidate probe check the git exit code and block on failure instead of
      relying on `ignoreFailure` + empty stdout.
- [ ] 3.2 Block with `needs-human` when the worktree is missing while OpenSpec is active and the
      PR file list contains an `openspec/changes/<id>/` path; keep the plain `null` skip otherwise.
- [ ] 3.3 Keep the existing `unavailable` CLI behavior and the spec-consistency guard untouched.

## 4. Archive-failure surfacing

- [ ] 4.1 Regression test: `openspecArchive` fake returns `{ code: 1, output: "… header not
      found …" }`; assert blocked outcome, `openspec-invalid`, CLI output verbatim in the reason,
      no advance.

## 5. Evidence

- [ ] 5.1 Emit a run event recording the archive decision (`archived` ids / `skipped` +
      reason / `blocked` + reason) via the existing run-store seam.
- [ ] 5.2 Test the event is written for the archived, skipped, and blocked cases.

## 6. Override-resume regression

- [ ] 6.1 Test the resumed path: delta-review blocker cleared via the override flow →
      `advancePreMerge` re-entered → `deps.openspecArchive` fake records the call and, with an
      unarchived change in the PR file list, the run blocks instead of reaching `ready-to-deploy`.

## 7. Gate

- [ ] 7.1 `cd core && npm test`.
- [ ] 7.2 `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 7.3 `npm run ci` from the repo root — green.
