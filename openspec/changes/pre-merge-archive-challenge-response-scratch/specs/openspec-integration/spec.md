## ADDED Requirements

### Requirement: Pre-archive cleanliness SHALL ignore pipeline-owned challenge-response scratch alone

Before invoking `openspec archive`, the pre-merge archive step SHALL inspect
`git status --porcelain` and SHALL treat the worktree as clean enough to archive
when the only dirty paths are pipeline-owned non-product scratch matching the
engine-known pattern `artifacts/challenge-response-*.json` and/or pipeline-internal
marker files already excluded from archive dirt decisions. In that
scratch-and/or-marker-only case the step SHALL NOT call `setBlocked` solely for
those paths, and SHALL proceed with archive evaluation (it MAY best-effort remove
those scratch or marker paths first so later porcelain checks stay clean). The step
SHALL NOT auto-commit challenge-response JSON into the product tree.

When porcelain still contains product-relevant dirt after excluding that
non-product residual — including paths under `core/`, `plugin/`, dirty paths under
`openspec/`, hosts/scripts product trees, recognized lockfiles, other non-scratch
paths, or rename/copy records whose product endpoint remains dirty — the step
SHALL call `setBlocked` with stage `pre-merge` and type `needs-human` (or the
established workspace-dirt block kind for this guard), SHALL NOT invoke
`openspec archive`, and SHALL disclose the product-relevant dirty paths. When
`git status --porcelain` exits nonzero, the step SHALL fail closed with
`setBlocked` and SHALL NOT treat the tree as clean.

#### Scenario: Challenge-response dump alone does not block pre-archive cleanliness

- **WHEN** `maybeArchiveOpenspec` runs the pre-archive cleanliness guard
- **AND** `git status --porcelain` exits 0 and lists only
  `?? artifacts/challenge-response-<N>.json` (or another
  `artifacts/challenge-response-*.json` basename under `artifacts/`)
- **THEN** the step SHALL NOT call `setBlocked` solely for that path
- **AND** SHALL proceed with archive evaluation (or remove the dump first and then
  proceed)
- **AND** SHALL NOT auto-commit the challenge-response file into the product tree

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
