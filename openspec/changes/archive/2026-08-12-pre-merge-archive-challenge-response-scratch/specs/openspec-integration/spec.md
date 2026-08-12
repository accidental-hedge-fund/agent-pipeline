## ADDED Requirements

### Requirement: Pre-archive cleanliness SHALL ignore pipeline-owned challenge-response scratch alone

Before invoking `openspec archive`, the pre-merge archive step SHALL inspect
`git status --porcelain` and SHALL treat the worktree as clean enough to archive
when the only dirty paths are **untracked** pipeline-owned non-product scratch
matching the engine-known pattern `artifacts/challenge-response-*.json` (porcelain
status `??`) and/or pipeline-internal marker files already excluded from archive
dirt decisions. In that untracked-scratch-and/or-marker-only case the step SHALL
NOT call `setBlocked` solely for those paths, and SHALL proceed with archive
evaluation (it MAY best-effort remove those scratch or marker paths first so later
porcelain checks stay clean). The step SHALL NOT auto-commit challenge-response
JSON into the product tree: tracked/staged/modified challenge-response paths
SHALL block pre-archive (they are not git-cleanable and would ride into
`git add -A` or be discarded by destructive rollback), and any residual scratch
that is still present after archive staging SHALL be unstaged before the archive
commit so it cannot enter the product tree. If `git restore --staged` exits
nonzero, or a post-unstage porcelain re-read (XY fields preserved) still shows
engine-known scratch staged in the index, the step SHALL call `setBlocked` with
stage `pre-merge` and SHALL NOT invoke `git commit` for the archive.

When porcelain still contains product-relevant dirt after excluding that
untracked non-product residual — including paths under `core/`, `plugin/`, dirty
paths under `openspec/`, hosts/scripts product trees, recognized lockfiles, other
non-scratch paths, **tracked/modified engine-known scratch** (e.g.
` M artifacts/challenge-response-*.json`), or rename/copy records whose product
endpoint remains dirty — the step SHALL call `setBlocked` with stage `pre-merge`
and type `needs-human` (or the established workspace-dirt block kind for this
guard), SHALL NOT invoke `openspec archive`, and SHALL disclose the
product-relevant dirty paths. When `git status --porcelain` exits nonzero, the
step SHALL fail closed with `setBlocked` and SHALL NOT treat the tree as clean.

#### Scenario: Challenge-response dump alone does not block pre-archive cleanliness

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** `git status --porcelain` exits 0 and lists only
  `?? artifacts/challenge-response-<N>.json` (or another
  `artifacts/challenge-response-*.json` basename under `artifacts/`)
- **THEN** the step SHALL NOT call `setBlocked` solely for that path
- **AND** SHALL proceed with archive evaluation (or remove the dump first and then
  proceed)
- **AND** SHALL NOT auto-commit the challenge-response file into the product tree

#### Scenario: Tracked challenge-response modification blocks pre-archive

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** porcelain lists a tracked or modified challenge-response path (e.g.
  ` M artifacts/challenge-response-<N>.json` or staged `M  …`) with or without an
  active archive candidate
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge`
- **AND** SHALL NOT invoke `openspec archive`
- **AND** the block reason SHALL disclose the tracked challenge-response path
- **AND** SHALL NOT auto-commit that path into the product tree

#### Scenario: Challenge-response dump plus product dirt still blocks

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** porcelain lists both `artifacts/challenge-response-<N>.json` and a
  product path (e.g. a modified `core/scripts/foo.ts` or a dirty
  `openspec/specs/...` file)
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge` for the
  product-relevant dirt
- **AND** SHALL NOT invoke `openspec archive`
- **AND** the block reason SHALL disclose product-relevant dirty paths
- **AND** SHALL NOT treat the challenge-response path as sufficient to waive the
  product block

#### Scenario: Dirty openspec product path alone still blocks

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** porcelain reports a dirty path under `openspec/` that is not solely a
  pipeline-owned challenge-response or marker residual outside that tree
- **THEN** the step SHALL call `setBlocked` and SHALL NOT invoke `openspec archive`
- **AND** the reason SHALL make clear that destructive archive-failure rollback
  could discard that work

#### Scenario: Failed git status remains fail-closed

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** `git status --porcelain` exits nonzero
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge`
- **AND** SHALL NOT treat the worktree as clean
- **AND** SHALL NOT invoke `openspec archive`

#### Scenario: Unit regression covers challenge-response-only porcelain

- **WHEN** the unit suite exercises `maybeArchiveOpenspec` with injectable porcelain
  listing only `?? artifacts/challenge-response-<N>.json` and a successful status exit
- **THEN** the test SHALL assert `setBlocked` is not called for that dirt alone
- **AND** the test SHALL fail if challenge-response-only dirt reintroduces a
  pre-archive `setBlocked` for that path alone

#### Scenario: Unit regression covers tracked challenge-response blocking

- **WHEN** the unit suite exercises `maybeArchiveOpenspec` with injectable porcelain
  listing a tracked/modified `artifacts/challenge-response-*.json` path and an
  active archive candidate
- **THEN** the test SHALL assert `setBlocked` is called and `openspec archive` is
  not invoked

#### Scenario: Failed post-archive unstage blocks before commit

- **WHEN** `maybeArchiveOpenspec` has successfully archived candidates and staged
  the archive diff with `git add -A`
- **AND** residual engine-known scratch is staged (e.g.
  `A  artifacts/challenge-response-<N>.json`)
- **AND** `git restore --staged` for that scratch exits nonzero
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge`
- **AND** SHALL NOT invoke `git commit` for the archive
- **AND** the block reason SHALL disclose the unstage failure and/or the staged
  scratch path

#### Scenario: Scratch still staged after unstage blocks before commit

- **WHEN** `maybeArchiveOpenspec` runs the post-archive unstage safeguard
- **AND** `git restore --staged` exits zero
- **AND** a subsequent `git status --porcelain` still lists engine-known scratch
  with a dirty index column (not `??` / worktree-only)
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge`
- **AND** SHALL NOT invoke `git commit` for the archive
- **AND** the block reason SHALL disclose the still-staged scratch path

## MODIFIED Requirements

### Requirement: Archive commit failure blocks pre-merge and prevents push

After `openspec archive` succeeds and `git add -A` stages a non-empty diff, the pre-merge stage SHALL check whether `git commit` exits zero. If the commit exits non-zero, the stage SHALL call `setBlocked` with the commit stderr as the blocking reason and SHALL return `{ status: "blocked" }` without invoking `git push`. The push MUST NOT be attempted when the archive commit fails.

#### Scenario: commit fails after archive produces diff

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds for all active candidates
- **AND** `git status --porcelain` reports a non-empty diff (staged files)
- **AND** `git commit` exits non-zero (e.g., rejected by a pre-commit hook or git config error)
- **THEN** the stage SHALL set a pre-merge blocker on the issue with the commit stderr included in the reason
- **AND** SHALL return `{ advanced: false, status: "blocked", reason: "archive commit failed" }` (or equivalent)
- **AND** SHALL NOT invoke `git push origin <branch>`

#### Scenario: worktree has dirty state outside openspec/ before archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `git status --porcelain` (run before `openspec archive`) reports
  product-relevant dirty paths outside pure pipeline-owned residual (paths that
  remain after excluding pipeline-internal markers and engine-known non-product
  scratch such as `artifacts/challenge-response-*.json`)
- **THEN** the stage SHALL set a pre-merge blocker on the issue
- **AND** SHALL return `{ advanced: false, status: "blocked" }` without invoking `openspec archive`

#### Scenario: commit succeeds — push proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds and a non-empty diff is staged
- **AND** `git commit` exits zero
- **THEN** the stage SHALL proceed to `git push origin <branch>` as before
- **AND** the existing push-failure and waiting paths SHALL remain unchanged
