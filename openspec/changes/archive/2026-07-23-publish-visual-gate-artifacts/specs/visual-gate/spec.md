# visual-gate delta

## MODIFIED Requirements

### Requirement: Repo opts in via a visual_gate config block

The pipeline SHALL let a repo opt in to the visual gate by declaring a `visual_gate` block in
`.github/pipeline.yml` with `enabled: true` and a `command` string. The block SHALL accept
`enabled`, `command`, `mode`, `timeout`, `max_attempts`, `artifacts_dir`, and `publish`, SHALL reject
unknown keys, and SHALL require no per-issue human configuration. `publish` SHALL be a boolean that
defaults to `false` when absent.

#### Scenario: visual_gate block present with enabled true

- **WHEN** `.github/pipeline.yml` contains `visual_gate.enabled: true` and `visual_gate.command: "<cmd>"`
- **THEN** `PipelineConfig.visual_gate.enabled` SHALL be `true`
- **AND** `PipelineConfig.visual_gate.command` SHALL equal `"<cmd>"`

#### Scenario: visual_gate block absent

- **WHEN** `.github/pipeline.yml` has no `visual_gate` block
- **THEN** `PipelineConfig.visual_gate.enabled` SHALL default to `false`
- **AND** `PipelineConfig.visual_gate.mode` SHALL default to `"gate"`
- **AND** `PipelineConfig.visual_gate.publish` SHALL default to `false`

#### Scenario: publish accepted and defaulted

- **WHEN** the `visual_gate` block sets `publish: true`
- **THEN** `PipelineConfig.visual_gate.publish` SHALL be `true`
- **AND** **WHEN** the block omits `publish`
- **THEN** `PipelineConfig.visual_gate.publish` SHALL be `false`

#### Scenario: unknown key rejected

- **WHEN** the `visual_gate` block contains a key outside the accepted set
- **THEN** config parsing SHALL produce an error diagnostic naming the unknown key

### Requirement: Visual artifacts SHALL be captured and recorded as evidence

The stage SHALL, after each command run, enumerate the files under the configured
`visual_gate.artifacts_dir` (worktree-relative, default `.pipeline-visual`), copy them into the run
directory so they survive worktree cleanup, and record a deterministic relative-path manifest in the
issue's evidence bundle. Enumeration SHALL be bounded by a maximum file count and total size, and
SHALL note explicitly when the listing was truncated. A path that resolves outside the worktree root
SHALL be rejected with an error rather than read. When a file is copied into the run directory and
that copy fails, the stage SHALL record that file as copy-failed, SHALL NOT count it as captured, and
SHALL surface the copy failure per file in the manifest — a file SHALL be reported captured only once
it has actually been persisted.

#### Scenario: artifacts captured and manifested

- **WHEN** the visual command writes screenshots into `artifacts_dir`
- **THEN** the stage SHALL copy those files into the run directory
- **AND** SHALL record their relative paths as an artifact manifest in the evidence bundle

#### Scenario: missing or empty artifacts directory

- **WHEN** `artifacts_dir` does not exist or contains no files after the run
- **THEN** the stage SHALL record an explicit "no artifacts captured" note
- **AND** the pass/fail outcome SHALL be unchanged by the absence

#### Scenario: bounded enumeration

- **WHEN** the artifacts directory exceeds the file-count or total-size bound
- **THEN** the manifest SHALL list the bounded subset
- **AND** SHALL state that the listing was truncated

#### Scenario: path escaping the worktree is rejected

- **WHEN** `visual_gate.artifacts_dir` resolves outside the issue worktree root
- **THEN** the stage SHALL produce an error diagnostic
- **AND** SHALL NOT read or copy files from that location

#### Scenario: per-file copy failure is surfaced, not reported as captured

- **WHEN** an enumerated artifact file's copy into the run directory fails
- **THEN** the stage SHALL list that file under an explicit copy-failed note in the manifest
- **AND** SHALL NOT include that file in the captured file list
- **AND** SHALL NOT publish that file

## ADDED Requirements

### Requirement: The visual gate SHALL support opt-in publishing of captured artifacts to the PR branch

The stage SHALL, when `visual_gate.publish` is `true` and the deciding run captured at least one
artifact, write the captured files to a dedicated worktree evidence path distinct from
`artifacts_dir`, force-add only that path, commit it with a pipeline-internal subject, and push the
commit to the PR branch — so the artifacts are viewable from the PR without runner-filesystem access.
Publishing SHALL occur once per pass, after the attempt loop has settled, for both pass and fail
outcomes and in both `gate` and `advisory` mode. When `visual_gate.publish` is `false` or absent, the
stage SHALL make no publish commit and no PR-branch write beyond the existing #395 behavior, and the
manifest SHALL list bare relative paths as before.

#### Scenario: publish disabled — no PR-branch write

- **WHEN** `visual_gate.publish` is `false` (or absent) and the visual command runs
- **THEN** the stage SHALL NOT create a publish commit
- **AND** SHALL NOT push any evidence commit to the PR branch
- **AND** the artifact manifest SHALL list bare relative paths exactly as in #395

#### Scenario: publish enabled — artifacts committed and pushed

- **WHEN** `visual_gate.publish` is `true` and the deciding run captured at least one artifact
- **THEN** the stage SHALL write the captured files under a dedicated evidence path in the worktree
- **AND** SHALL commit that path and push the commit to the PR branch

#### Scenario: publish enabled but nothing captured

- **WHEN** `visual_gate.publish` is `true` and the deciding run captured no artifacts
- **THEN** the stage SHALL NOT create a publish commit

#### Scenario: publish failure is best-effort and never blocks a passing gate

- **WHEN** `visual_gate.publish` is `true`, the visual command exits 0, and the publish commit or
  push fails
- **THEN** the stage SHALL surface the publish failure in the evidence comment
- **AND** SHALL fall back to non-published (bare-path) manifest entries for that run
- **AND** SHALL NOT block the gate on the publish failure

### Requirement: Published artifact evidence SHALL be bounded

The stage SHALL bound publishing by a fixed maximum published-file count and a maximum total
published-byte budget that are tighter than the enumeration bounds, applied over the captured files
in deterministic order. A file that would exceed a publish bound SHALL NOT be committed, and its
manifest entry SHALL be annotated to state it was not published because it exceeds the bound. The
stage SHALL write a single evidence set for the deciding run, replacing any prior published set in the
same commit so at most one bounded evidence set is present on the branch.

#### Scenario: over-bound file is not committed and is annotated

- **WHEN** publishing is enabled and a captured file would exceed the published-file-count or
  published-byte bound
- **THEN** the stage SHALL NOT commit that file
- **AND** its manifest entry SHALL state that it was not published because it exceeds the bound

#### Scenario: prior published set is replaced

- **WHEN** publishing runs and a prior evidence set exists at the evidence path from an earlier pass
- **THEN** the publish commit SHALL replace the prior set so a single evidence set remains

### Requirement: The artifact-publish commit SHALL be pipeline-internal

The stage SHALL author the publish commit with a prescribed subject that `isPipelineInternalCommit`
classifies as pipeline-internal, so the commit does NOT invalidate a recorded pre-merge review
verdict (#16/#98) and cannot trigger a re-review cascade. The publish subject SHALL NOT match the
visual-fix commit message pattern, so a published-evidence commit is never mistaken for a visual-fix
commit that owes a pre-merge re-review.

#### Scenario: publish commit does not invalidate the review verdict

- **WHEN** a publish commit is the only commit that landed on the PR since the last reviewed SHA
- **THEN** the pre-merge review-SHA gate SHALL classify it as pipeline-internal
- **AND** SHALL NOT require a re-review on account of that commit

#### Scenario: publish commit is not read as a visual-fix commit

- **WHEN** the stage evaluates whether a visual-fix commit is pending review
- **THEN** the publish commit's subject SHALL NOT match the visual-fix commit pattern
- **AND** a passing gate SHALL NOT be routed back to `pre-merge` solely because evidence was published

### Requirement: Manifest entries SHALL link to the published location

The stage SHALL, when a captured file has been published, render its manifest entry as a Markdown
link to the committed artifact at a branch-relative `https://github.com/<repo>/blob/<branch>/
<evidence-path>` URL rather than as a bare filename, so the link resolves from the PR after the
worktree is removed. A captured file that was not published (publishing disabled, over a bound, a
copy failure, or a publish push failure) SHALL be rendered as a bare relative path with the
corresponding annotation, and SHALL NOT be rendered as a link.

#### Scenario: published file links to its blob URL

- **WHEN** publishing is enabled and a captured file was committed and pushed
- **THEN** its manifest entry SHALL be a Markdown link to a
  `https://github.com/<repo>/blob/<branch>/<evidence-path>` URL for that file
- **AND** the entry SHALL NOT be a bare filename

#### Scenario: unpublished file stays a bare path

- **WHEN** publishing is disabled, or the file was excluded by a bound, or its copy or the publish
  push failed
- **THEN** its manifest entry SHALL be a bare relative path with the corresponding annotation
- **AND** SHALL NOT be a link
