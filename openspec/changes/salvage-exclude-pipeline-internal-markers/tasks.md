## 1. Single-source the pipeline-internal marker filename

- [ ] 1.1 In `core/scripts/salvage-harness-work.ts`, add an exported canonical constant for
      pipeline-internal marker filenames — `PIPELINE_INTERNAL_MARKER_FILES = [".pipeline-rebase-attempted"]`
      — plus the derived depth-agnostic exclusion pathspecs
      (`:(exclude,glob)**/.pipeline-rebase-attempted`).
- [ ] 1.2 In `core/scripts/stages/pre_merge.ts`, make `REBASE_MARKER_FILE` refer to the canonical
      constant (import it) so the marker writer and the salvage exclusion never drift.

## 2. Exclude the marker from the salvage dirtiness check

- [ ] 2.1 In `defaultGitStatus` (unscoped) and the scoped status branch, restrict
      `git status --porcelain` so a pipeline-internal marker file is not counted as salvageable
      work (pathspec exclusion including an explicit `.` so the exclude-only pathspec still matches
      the rest of the tree).
- [ ] 2.2 Confirm a worktree whose only dirty path is the marker yields empty (clean) status →
      `salvageUncommittedWork` returns `{ salvaged: false }` and `gitAddAll`/`gitCommit` are not
      called.

## 3. Exclude the marker from the salvage staging add

- [ ] 3.1 Fold the marker exclusion pathspecs into the unscoped `SALVAGE_GIT_ADD_ARGS` alongside
      `SALVAGE_NODE_MODULES_EXCLUDE`.
- [ ] 3.2 Fold the same marker exclusion into the scoped add-args branch, preserving the existing
      `openspec/` scope and node_modules exclusion.

## 4. Tests (prove they bite)

- [ ] 4.1 `core/scripts/salvage-harness-work.test.ts`: dirty worktree whose only path is
      `.pipeline-rebase-attempted` → `salvageUncommittedWork` returns `{ salvaged: false }`,
      `gitAddAll`/`gitCommit` not called. Prove it bites: without the marker exclusion in the
      status check, a salvage commit whose only content is the marker is produced.
- [ ] 4.2 `core/scripts/salvage-harness-work.test.ts`: dirty worktree with a real changed file
      **and** the marker → salvage stages the real file, `gitAddAll` args include the marker
      exclusion pathspec, and the marker is not committed.
- [ ] 4.3 `core/scripts/salvage-harness-work.test.ts`: the scoped (`openspec/`) salvage still stages
      only `openspec/` and additionally excludes the marker; existing scoped tests still pass.
- [ ] 4.4 Drift-guard test: assert `REBASE_MARKER_FILE` (pre_merge) equals the canonical
      `PIPELINE_INTERNAL_MARKER_FILES` entry, so the two cannot diverge.

## 5. Mirror + CI

- [ ] 5.1 `node scripts/build.mjs` — regenerate the `plugin/` mirror; commit it in the same change.
- [ ] 5.2 `npm run ci` passes green from the repo root (core tests, mirror check, install smoke,
      `openspec validate --all`).
