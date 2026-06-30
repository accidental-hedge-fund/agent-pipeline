## 1. Commit the OpenSpec project config during planning

- [ ] 1.1 Add a helper in `core/scripts/stages/planning.ts` (or a small co-located module it
  imports), e.g. `commitOpenspecProjectConfig(wtPath, issueNumber, pipelineRunId, deps)`, with an
  injectable `deps` seam (`gitStatus`, `gitAdd`, `gitCommit`) defaulting to the real
  `gitInWorktree` wrappers — mirroring the salvage/verify dep-injection pattern.
- [ ] 1.2 Implementation: run `git status --porcelain -- openspec/config.yaml`; if the output is
  non-empty (untracked `??` or modified), `git add -- openspec/config.yaml` then `git commit` with
  `withTrailers("chore: track openspec/config.yaml (#<n>)", issueNumber, pipelineRunId)`. If the
  output is empty, return without committing (no-op).
- [ ] 1.3 Wire the call into the OpenSpec authoring path in `makeOpenspecPlanningHooks` →
  `authorArtifact`, **after** `salvageIfNoNewCommit(..., "openspec/")` and **before** the
  `verifyHarnessCommits` path-constraint check, so the committed config is inside the verified
  range.
- [ ] 1.4 Confirm the bootstrap branch (`!isInit(wt.path)` → `openspec init` + `git add -A`) is
  untouched and that the new step is a no-op there (config already committed).

## 2. Surface the dirty paths in the test-gate block

- [ ] 2.1 In `core/scripts/testgate.ts`, add a `gitStatusPorcelain(cwd): Promise<string>` seam to
  `TestGateDeps` (default `git status --porcelain` via `gitInWorktree`); derive dirtiness from the
  trimmed output length.
- [ ] 2.2 At the pre-run dirty block (the `if (await gitDirtyFn(wtPath))` before the first run) and
  the passing-run-left-artifacts block, append the trimmed porcelain output to `blockReason` under
  an `Uncommitted paths:` label, truncated via the existing output-cap helper.
- [ ] 2.3 Keep the boolean `gitDirty` behavior intact for callers that only need a yes/no, or
  repurpose it consistently — do not change non-dirty-path control flow.

## 3. Regression tests (must bite)

- [ ] 3.1 `planning.test.ts` (or `track-openspec-config.test.ts`): fake worktree where the harness
  committed an `openspec/changes/<id>/` change and `gitStatus` reports `?? openspec/config.yaml`;
  assert the new step calls `gitAdd` scoped to `openspec/config.yaml` and `gitCommit` with the
  trailers, and that the post-step status is clean. Prove it bites: with the step removed, the
  worktree stays dirty (the path-constraint/test-gate would see `config.yaml`).
- [ ] 3.2 No-op test: `gitStatus` reports nothing for `openspec/config.yaml` → assert neither
  `gitAdd` nor `gitCommit` is called and no error is raised.
- [ ] 3.3 `testgate.test.ts`: fake `gitStatusPorcelain` returns `?? openspec/config.yaml`; assert
  the pre-run dirty block reason contains that path. Add an analogous assertion for the
  passing-run-left-artifacts block. Prove it bites: with the path-surfacing removed, the reason
  omits the path.
- [ ] 3.4 Truncation test: a large fake porcelain list is truncated in the reason with a truncation
  marker.

## 4. Mirror + CI

- [ ] 4.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 4.2 `npm run ci` green end-to-end (core tests, `build.mjs --check`, install-smoke,
  `openspec validate --all`).
