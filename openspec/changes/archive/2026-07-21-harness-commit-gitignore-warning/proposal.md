## Why

When an implementing or fix-round harness creates a file its own committed change
depends on but the target repo's `.gitignore` excludes that file, the commit step
silently skips it. The run looks green locally while the pushed change is missing a
file it needs, and CI fails downstream at pre-merge with a mysterious "missing
committed file" error far from the cause. Observed 2026-07-20 in lyric-utils
#659 / PR #704: the implementing harness generated `benchmark/regime_4cell/results.json`
and committed a test asserting the file is committed, but the root `.gitignore`
`*.json` rule silently excluded it; a human had to hand-diagnose the gitignore
interaction at a downstream CI failure. This change surfaces the exclusion loudly at
the stage that caused it, so it is diagnosed there instead of at CI.

## What Changes

- Add a `detect-ignored-artifacts` helper (`core/scripts/ignored-artifact-warning.ts`)
  that, after a harness commit step produces a commit, enumerates untracked files the
  worktree's gitignore excludes, keeps only those **referenced by name in the text of
  the committed diff** (the change-relevance heuristic), and resolves each surviving
  file's matching ignore rule and source via `git check-ignore -v`.
- Wire the helper into the implementing stage (`stages/planning.ts`) and the fix-round
  stage (`stages/fix.ts`) after their commit step, when the harness range is non-empty.
- On a hit, emit an **advisory warning** — a `[pipeline]` line in stage output naming
  each excluded file with its matching ignore rule/source, plus an
  `ignored_artifact_warning` event in `events.jsonl` (run evidence) carrying the same
  per-file records.
- Detection is **advisory only** — it never blocks and never mutates the worktree
  (no force-add, no un-ignore). Any git error during detection is swallowed and the
  stage proceeds exactly as before.
- Noise control: routine ignored clutter (caches, `__pycache__`, build dirs,
  `node_modules`) is not referenced by the committed diff and therefore does not warn.

## Acceptance Criteria

- [ ] After a harness commit step (implementing and fix rounds), the pipeline detects
      newly untracked files excluded by gitignore that are referenced by name in the
      committed diff, and reports each in stage output and in an `events.jsonl` event,
      naming the file and its matching ignore rule/source.
- [ ] An ignored untracked file that is **not** referenced by the committed diff (e.g.
      `__pycache__/foo.pyc`, `node_modules/...`, a stray build artifact) produces no
      warning.
- [ ] Detection is advisory: it never sets a blocker, never changes stage
      advance/blocking semantics, and never mutates or stages the ignored file.
- [ ] Any git failure during detection is non-fatal — the stage proceeds without a
      warning, exactly as if no ignored artifact were present.
- [ ] A repo with no change-referenced ignored files behaves exactly as before this
      change (no new output, no new event).
- [ ] Unit tests via the existing deps-seam pattern cover: (a) ignored new file
      referenced by the committed diff → warning naming the file and rule; (b)
      unreferenced ignored clutter → no warning; (c) git failure during detection →
      stage proceeds without the warning. The referenced-file test bites: with the
      detection removed, the file is silently dropped and no warning is produced.

## Capabilities

### New Capabilities
- `harness-commit-gitignore-warning`: After a harness commit step, the pipeline
  advisorily warns when a gitignored, change-referenced artifact was left uncommitted,
  naming the file and its matching ignore rule/source in stage output and run evidence.

### Modified Capabilities
- (none — the detection is purely additive and does not change any existing
  requirement, stage edge, or blocking semantics.)

## Impact

- New: `core/scripts/ignored-artifact-warning.ts` and co-located
  `core/scripts/ignored-artifact-warning.test.ts`.
- Edited: `core/scripts/stages/planning.ts` (implementing commit step),
  `core/scripts/stages/fix.ts` (fix-round commit step), and
  `core/scripts/run-store.ts` (new `ignored_artifact_warning` event type).
- Regenerated `plugin/` mirror (`node scripts/build.mjs`).
- No changes to state-machine edges, review/fix blocking semantics, or the freeform
  (non-OpenSpec) path. Repos with no change-referenced ignored files are unaffected.
