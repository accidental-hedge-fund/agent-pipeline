## Why

#395 shipped the visual gate: it runs a repo-defined E2E/visual suite, copies the artifacts it
declares (screenshots, diffs, traces) into the run directory, and posts a `## Visual Gate` comment
whose "Artifacts" section lists their **bare relative filenames**. That satisfied #395's acceptance
criterion ("artifact links/inline evidence as an issue/PR comment"), but the copied files live only
on the runner's filesystem under the run store — a human reviewing the PR at `ready-to-deploy`
**cannot open them**. Review finding b2c42fc0 (round 2, high, conf 0.99) called this out: the user
story aspires to screenshots/diffs a human can actually SEE from the PR, without shell access to the
runner.

A second, smaller defect ships in the same area: `captureArtifacts` marks every enumerated file
`captured: true` even when the copy into the run directory silently fails (`copyFile(...).catch(() =>
{})`), so the manifest can claim a file was captured that was never persisted (finding d50013b8,
medium advisory, shipped). Evidence that lies about what it holds is worse than absent evidence.

## What Changes

- **Opt-in publish of captured artifacts to the PR branch.** A new `visual_gate.publish` config key
  (boolean, default `false`) makes the gate, after capture, write the final run's captured artifacts
  to a bounded, dedicated evidence path in the worktree, `git add -f` that path, commit it with a
  **pipeline-internal** subject, and push it to the PR branch — so the images render in the PR's
  "Files changed" tab and resolve from links in the evidence comment, with no runner-filesystem
  access required. Default-off preserves today's behavior byte-for-byte for repos that don't opt in.
- **Bounded publish, addressing repo bloat.** Publishing is governed by publish-specific bounds
  (file count, per-file bytes, total bytes) that are tighter than the enumeration bounds, because
  committed blobs bloat git history permanently. Over-bound files are listed in the manifest as
  "not published (exceeds bound)" rather than committed. Publishing writes a single evidence set for
  the deciding run and replaces any prior published set in the same commit.
- **The publish commit is pipeline-internal.** It uses a prescribed subject that
  `isPipelineInternalCommit` recognizes, so it does NOT invalidate the pre-merge review-SHA gate
  (#16/#98) and cannot start a non-converging re-review cascade, and is never mistaken for a
  visual-fix commit by the fix-round routing.
- **Manifest entries link to the published location.** When publishing is enabled and a file was
  published, its manifest entry is a Markdown link to the committed blob (a `github.com/<repo>/blob/
  <branch>/<path>` URL that survives worktree cleanup), not a bare filename. When publishing is off
  or a file was not published, the entry stays a plain relative path with an explicit annotation.
- **Per-file copy-failure surfacing (fold in d50013b8).** When copying captured files into the run
  directory, a file whose copy fails is recorded as **copy-failed**, never as captured, and is
  surfaced per-file in the manifest and comment. A file is only ever reported as captured/published
  once it has actually been persisted.

## Capabilities

### New Capabilities

<!-- none — this extends the existing visual-gate capability -->

### Modified Capabilities

- `visual-gate`: add opt-in artifact publishing to the PR branch (new `visual_gate.publish` key,
  bounded evidence commit, pipeline-internal classification, manifest links to the published
  location) and correct artifact capture to surface per-file copy failures instead of reporting
  copy-failed files as captured.

## Impact

- Affected specs: **visual-gate** (config surface, capture semantics, new publish behavior).
- Affected code (implementation step, not this change): `core/scripts/config.ts` (add `publish` to
  the strict `visual_gate` block, default, scaffold), `core/scripts/stages/visual.ts` (per-file
  copy result, publish step, manifest link rendering), `core/scripts/stages/pre_merge.ts`
  (`isPipelineInternalCommit` recognizes the publish subject), `core/test/`, README, and the
  regenerated `plugin/` mirror.
- Rollback: `visual_gate.publish: false` (the default) — no publish commit, no PR-branch writes.

## Acceptance criteria

- [ ] `.github/pipeline.yml` accepts `visual_gate.publish` (boolean); it defaults to `false` when
      absent, and the strict schema still rejects unknown keys under `visual_gate`.
- [ ] With `visual_gate.publish: false` (or absent), the gate spawns no publish commit and makes no
      write to the PR branch beyond today's behavior; the manifest lists bare relative paths exactly
      as it does now.
- [ ] With `visual_gate.publish: true` and captured artifacts present, the gate writes those files
      under a dedicated worktree evidence path, commits them with a pipeline-internal subject, and
      pushes the commit to the PR branch.
- [ ] The publish commit's subject matches `isPipelineInternalCommit`, so it does NOT invalidate a
      prior pre-merge review verdict and does NOT match the visual-fix commit pattern.
- [ ] Each published file's manifest entry is a Markdown link to a
      `https://github.com/<repo>/blob/<branch>/<evidence-path>` URL, not a bare filename.
- [ ] Publishing is bounded: at most a fixed file count and total byte budget (tighter than the
      enumeration bounds) are committed; files beyond the bound are listed as
      "not published (exceeds bound)" and are not committed.
- [ ] When copying a captured file into the run directory fails, that file is reported as copy-failed
      (surfaced per-file in the manifest/comment) and is NOT counted as captured or published.
- [ ] A publish push failure is surfaced in the evidence comment and does NOT block a gate that
      would otherwise pass (publishing evidence is best-effort; it never turns a pass into a block).
- [ ] Unit tests cover publish on/off, bound enforcement, manifest-link rendering, pipeline-internal
      classification of the publish subject, and per-file copy-failure surfacing, using the existing
      dependency-seam pattern with no real network, git, or subprocess calls.
- [ ] `npm run ci` passes with the regenerated `plugin/` mirror committed.
