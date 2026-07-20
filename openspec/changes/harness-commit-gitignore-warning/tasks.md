## 1. Detection helper

- [ ] 1.1 Add `core/scripts/ignored-artifact-warning.ts` exporting
      `detectIgnoredArtifacts(wtPath, headBefore, headAfter, deps)` and an
      `IgnoredArtifactDeps` seam (`gitListIgnored`, `gitDiffText`, `gitCheckIgnore`,
      and an injectable event emitter), mirroring `SalvageDeps` in
      `salvage-harness-work.ts`.
- [ ] 1.2 Default `gitListIgnored` runs
      `git ls-files --others --ignored --exclude-standard` (repo-relative paths).
- [ ] 1.3 Default `gitDiffText` runs `git diff <headBefore> <headAfter>` and returns
      the raw diff text.
- [ ] 1.4 Default `gitCheckIgnore` runs `git check-ignore -v --no-index -- <path>` and
      parses `<source>:<line>:<pattern>\t<path>` into `{ source, line, pattern }`;
      a no-match/parse-miss yields a null rule (file still reported).
- [ ] 1.5 Implement the change-relevance filter: keep an ignored file only when its
      repo-relative path OR its basename appears literally in the committed diff text.
- [ ] 1.6 Wrap the whole detection so any thrown/failed git call is swallowed
      (logged at most once) and returns "no warnings" — never throws to the caller.

## 2. Reporting

- [ ] 2.1 On a non-empty result, emit a single `console.warn` `[pipeline]` line naming
      each excluded file with its `source:line "pattern"` rule.
- [ ] 2.2 Add an `IgnoredArtifactWarningEvent` (`type: "ignored_artifact_warning"`,
      `{ stage, files: [{ path, source, line, pattern }] }`) to
      `core/scripts/run-store.ts` and its `RunEvent` union; append it to
      `events.jsonl` via the existing `appendEvent` path.

## 3. Stage wiring

- [ ] 3.1 In `core/scripts/stages/planning.ts`, call the detector after the
      implementing commit step (after salvage / commit verification), only when the
      harness range is non-empty.
- [ ] 3.2 In `core/scripts/stages/fix.ts`, call the detector after the fix-round
      commit step, only when `headBefore !== headAfter`.
- [ ] 3.3 Confirm the call sites treat the result as advisory only — no `setBlocked`,
      no change to the returned advance/blocked outcome.

## 4. Tests

- [ ] 4.1 `core/scripts/ignored-artifact-warning.test.ts`: ignored new file referenced
      by the committed diff → warning names the file and its rule/source; assert the
      `ignored_artifact_warning` event payload. Prove it bites: with the detector
      removed the file is silently dropped and no warning/event is produced.
- [ ] 4.2 Unreferenced ignored clutter (`__pycache__/foo.pyc`, `node_modules/...`) →
      no warning, no event.
- [ ] 4.3 A git failure in `gitListIgnored` / `gitDiffText` / `gitCheckIgnore` → the
      detector returns no warning and does not throw (stage proceeds).
- [ ] 4.4 Empty harness range (`headBefore === headAfter`) → detector is a no-op.

## 5. Mirror & gate

- [ ] 5.1 Run `node scripts/build.mjs` and commit the regenerated `plugin/` mirror.
- [ ] 5.2 Run `npm run ci` from repo root and confirm green.
