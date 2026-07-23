# Tasks — publish-visual-gate-artifacts

## 1. Config surface

- [x] 1.1 Add `publish: z.boolean().optional()` to the strict `visual_gate` Zod block in
      `core/scripts/config.ts`, with a describe string matching the block's style.
- [x] 1.2 Add `publish: false` to `DEFAULT_CONFIG.visual_gate` and the config-loader merge branch.
- [x] 1.3 Extend the `.github/pipeline.yml` scaffold writer with the commented `publish` line.
- [x] 1.4 Tests: `publish` defaults to `false`, an explicit `true` is preserved, an unknown key under
      `visual_gate` is still rejected, and the scaffold round-trips.

## 2. Per-file copy honesty (d50013b8)

- [x] 2.1 Change the copy seam (`copyArtifacts` / `defaultCopyArtifacts`) to return a per-file result
      (`{ rel, ok }[]`) instead of swallowing `copyFile` errors.
- [x] 2.2 In `captureArtifacts`, exclude copy-failed files from the captured `files` set and record
      them on a new `copyFailed` field of `ArtifactManifest`.
- [x] 2.3 Surface copy-failed files per file in `formatArtifactManifest` (explicit "copy failed" note)
      and thus in the `## Visual Gate` comment.
- [x] 2.4 Tests: a file whose copy fails is reported copy-failed, not captured, and is not published.

## 3. Publish step

- [x] 3.1 Add publish bound constants (`PUBLISH_MAX_FILES`, per-file cap, `PUBLISH_MAX_TOTAL_BYTES`),
      tighter than the enumeration bounds, and a deterministic bound-selection helper that partitions
      captured files into published vs. "exceeds bound".
- [x] 3.2 Implement the publish step in `visual.ts`: after the attempt loop settles on the deciding
      manifest, when `visual_gate.publish` is true and files were captured, write them to a dedicated
      evidence path (distinct from `artifacts_dir`), `git add -f` that path (replacing any prior set),
      commit with the prescribed pipeline-internal subject, and push. Best-effort: a git/push failure
      is surfaced and falls back to non-published entries; it never blocks a passing gate.
- [x] 3.3 Inject the publish git operations (add/commit/push) through the existing dependency-seam
      pattern so the step is unit-testable with no real git.
- [x] 3.4 Tests: publish on writes+commits+pushes; publish off makes no PR-branch write; nothing
      captured → no commit; push failure is surfaced and non-blocking on a passing gate.

## 4. Pipeline-internal classification

- [x] 4.1 Add the publish-commit subject prefix and teach `isPipelineInternalCommit`
      (`core/scripts/stages/pre_merge.ts`) to recognize it, without matching the visual-fix pattern.
- [x] 4.2 Tests: the publish subject is classified pipeline-internal (does not invalidate a verdict),
      and does NOT match `visualFixCommitPattern` (a pass is not routed back to pre-merge for it).

## 5. Manifest links

- [x] 5.1 Thread the published-location context (repo, branch, evidence path, per-file published flag)
      into `formatArtifactManifest`; render published files as blob-URL Markdown links and unpublished
      files as annotated bare paths.
- [x] 5.2 Tests: published entry is a `github.com/<repo>/blob/<branch>/...` link; disabled /
      over-bound / copy-failed / push-failed entries are bare annotated paths, never links.

## 6. Docs & mirror

- [x] 6.1 Document `visual_gate.publish` in the README visual-gate section: what it commits, the
      bounds, the pipeline-internal classification, and the repo-history tradeoff.
- [x] 6.2 Regenerate the mirror (`node scripts/build.mjs`) and commit `plugin/` in the same change.
- [x] 6.3 Run `npm run ci` from the repo root and confirm it is green.

## 7. OpenSpec validation

- [x] 7.1 `openspec validate publish-visual-gate-artifacts --strict` passes.
