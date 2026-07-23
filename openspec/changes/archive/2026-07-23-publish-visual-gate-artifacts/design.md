## Context

The visual gate (`core/scripts/stages/visual.ts`, #395) already enumerates the repo command's
declared `artifacts_dir`, bounds the listing, copies the files into `<runDir>/visual/<attempt-N>/`,
and lists their relative paths in the `## Visual Gate` comment and the evidence bundle. Those files
survive worktree cleanup but live only under the run store on the runner — a human on the PR cannot
open them. This change adds an opt-in step that makes the captured artifacts **viewable from the PR
itself**, and fixes a capture-fidelity bug where copy failures are reported as successful captures.

## Goals / Non-Goals

**Goals**

- An opt-in mechanism that makes captured visual artifacts openable from the PR without runner-shell
  access.
- Manifest entries that link to the published artifact, not bare filenames.
- Bounded publishing so the mechanism cannot bloat the repository.
- Capture that never claims a file it did not persist (per-file copy-failure honesty, d50013b8).

**Non-Goals**

- Changing the exit-code-only verdict, the gate/advisory modes, the fix-round recovery, or any other
  #395 behavior.
- Image diffing, screenshot comparison, or any interpretation of artifact contents.
- Provisioning browsers, a preview deployment, or an external object store.
- Any auto-merge or deploy path — the pipeline still stops at `ready-to-deploy`.

## Decisions

### 1. Mechanism: commit the evidence to the PR branch (not Actions artifacts)

**Decision:** when `visual_gate.publish` is true, write the deciding run's captured artifacts to a
dedicated evidence path in the worktree, `git add -f` that path, commit it with a pipeline-internal
subject, and push it to the PR branch. Manifest entries then link to the committed blob.

**Why not GitHub Actions `upload-artifact`:** the pipeline does not assume it runs inside an Actions
job (it runs from a developer/agent harness as often as from CI), Actions artifacts are downloadable
**zips** rather than inline-viewable images, and their links expire. Neither is "screenshots a human
can SEE on the PR." Committing image blobs is the only mechanism that renders inline in the PR's
"Files changed" tab and yields durable `blob/<branch>/<path>` URLs the comment can point at. The
pipeline already pushes commits to the PR branch (fix commits), so the commit/push/traceability
machinery exists.

**Honest tradeoff (repo bloat).** Committed blobs enter the branch's tree, and this repo
squash-merges, so a merged PR carries the final evidence tree into `main` unless a human removes it.
This is mitigated, not eliminated: publishing is **opt-in** (default off), **bounded** (§2), and
writes a **single evidence set** for the deciding run (replacing any prior set in the same commit),
so at most one bounded set is ever present. Repos that will not accept evidence in `main` history
leave `publish` off and rely on the run-store manifest exactly as today. This tradeoff is stated so a
reviewer weighs it explicitly rather than discovering it at merge.

### 2. Publish bounds are separate from — and tighter than — enumeration bounds

Enumeration already bounds the manifest at `MAX_ARTIFACT_FILES` (100) / `MAX_ARTIFACT_TOTAL_BYTES`
(50 MB). Those bounds protect the comment and run directory, but 50 MB of images committed per PR is
unacceptable permanent history. Publishing therefore uses its own, tighter constants
(`PUBLISH_MAX_FILES`, `PUBLISH_MAX_TOTAL_BYTES`, and a per-file cap), applied over the already-sorted
captured list in deterministic order. A file that would exceed a publish bound is **not committed**;
its manifest entry is annotated "not published (exceeds bound)" so the omission is explicit, never
silent. Keeping the bounds as reviewed internal constants (the same pattern #395 used for the
enumeration bounds) avoids adding tuning keys the strict schema would then have to police; the single
new config key is the on/off switch, `publish`.

### 3. The publish commit is pipeline-internal

The commit is authored by the pipeline, not a developer, and must not perturb review convergence. It
uses a prescribed subject (e.g. `chore: publish visual-gate evidence for #<N>`) that
`isPipelineInternalCommit` recognizes, joining the existing OpenSpec-archive prefix. Consequences,
all required by spec:

- The pre-merge review-SHA gate (#16/#98) classifies it internal, so it does **not** invalidate a
  recorded verdict and cannot start a re-review cascade — the hard-won convergence rule is preserved.
- Its subject does **not** match the visual-fix commit pattern (`fix: resolve visual-gate failures
  (#N)`), so `visualFixCommitPendingReview` never mistakes an evidence commit for a fix that owes a
  re-review, and a pass is not spuriously routed back to `pre-merge` because evidence was published.

### 4. When and how publishing runs

Publishing happens once, after the attempt loop settles on the **deciding run's** captured manifest,
for both pass and fail and in both gate and advisory mode (a failing gate's screenshots are exactly
what the human needs). It writes the captured files under the evidence path, force-adds only that
path, commits, and pushes. It is **best-effort**: a push (or git) failure is surfaced in the evidence
comment and degrades that run's manifest to non-published (bare paths), but it never converts an
otherwise-passing gate into a block — turning a green gate red because *evidence* failed to publish
would be the wrong kind of rigor. Because publishing runs after the last visual re-run, it cannot
disturb the working tree the command was evaluated against.

### 5. Manifest link rendering

`formatArtifactManifest` gains a published-location input. For a published file it emits
`- [<rel-path>](https://github.com/<repo>/blob/<branch>/<evidence-path>/<rel-path>)`; the URL is
branch-relative so it keeps resolving as the branch head advances and after the worktree is removed.
For a file that was captured but not published (publish off, over a bound, or push failed) it emits
the bare relative path plus the appropriate annotation. Copy-failed files (§6) are listed under an
explicit "copy failed" note and are never linked.

### 6. Per-file copy honesty (folds in d50013b8)

Today `defaultCopyArtifacts` swallows per-file `copyFile` errors and `captureArtifacts` marks every
enumerated file `captured: true` regardless. The copy seam changes to return a per-file result
(`{ rel, ok }[]`); a file whose copy fails is recorded in a `copyFailed` list on the manifest and is
excluded from `files` (the captured set) and from the publish input. The comment/manifest surface the
copy-failed files explicitly. This is scoped to the `runDir`-present copy path (the only path that
persists files); when `runDir` is absent no copy is attempted and enumeration-only behavior is
unchanged. Result: a file is reported captured only once it is actually on disk, and published only
once it is actually committed.

## Risks / Trade-offs

- **Main-history bloat** — addressed in §1/§2 (opt-in, bounded, single set); residual risk is
  accepted and documented.
- **Force-add into a gitignored path** — repos commonly gitignore the command's `artifacts_dir`;
  publishing therefore writes to a **distinct** evidence path and force-adds only that path, so the
  command's own scratch output is never swept into the commit.
- **Extra PR-branch commit** — one internal commit per publishing run; classified internal so it
  neither re-triggers review nor is read as a fix. Replacing the prior set keeps the tree to one
  evidence set.

## Migration

No migration. `visual_gate.publish` defaults to `false`; existing repos see identical behavior until
they opt in.
