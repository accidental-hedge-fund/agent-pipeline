## ADDED Requirements

### Requirement: Archive commit is pinned to the reviewed/pushed PR head

The pre-merge OpenSpec archive step SHALL create the archive commit on top of the
current reviewed/pushed PR head, never a stale local worktree base. Before running
`openspec archive`, the step SHALL fetch `origin` and fast-forward the worktree branch
to `origin/<branch>` (a fast-forward-only advance), so the archive commit's parent is the
head that review approved and CI last ran against. The fast-forward SHALL run only over a
clean worktree (the existing pre-archive cleanliness guard is a precondition). If the
fetch or fast-forward fails for any reason other than the worktree already being at
`origin/<branch>`, the step SHALL block rather than archive on an unsynced base.

#### Scenario: worktree behind remote is fast-forwarded before archiving

- **WHEN** the pre-merge archive step runs for an OpenSpec-active item
- **AND** the worktree `HEAD` is an ancestor of `origin/<branch>` (a fix was pushed from
  another checkout, so the worktree is behind the reviewed head)
- **THEN** the step SHALL fetch `origin` and fast-forward the worktree branch to
  `origin/<branch>` before committing the archive
- **AND** the archive commit SHALL descend from the reviewed/pushed head
- **AND** the resulting push SHALL be fast-forwardable

#### Scenario: worktree already at the reviewed head archives unchanged

- **WHEN** the pre-merge archive step runs
- **AND** the worktree `HEAD` already equals `origin/<branch>`
- **THEN** the step SHALL archive, commit, and push as before with no divergence block

#### Scenario: fetch/fast-forward failure blocks instead of archiving on a stale base

- **WHEN** the pre-merge archive step cannot fetch `origin` or cannot fast-forward the
  worktree to `origin/<branch>` for a reason other than already being in sync
- **THEN** the step SHALL block with a reason describing the sync failure
- **AND** SHALL NOT run `openspec archive`, commit, or push

### Requirement: Archive base must equal the reviewed head or the step blocks

The pre-merge OpenSpec archive step SHALL, after attempting the fetch + fast-forward,
verify that the worktree `HEAD` equals the reviewed/pushed head (`origin/<branch>`) before
committing the archive. If the two SHAs differ — the fast-forward could not reconcile them
because local and remote have genuinely diverged — the step SHALL block with a diagnostic
that names both the archive base SHA and the reviewed-head SHA (of the form "archive base
`<x>` != reviewed head `<y>`"), and SHALL NOT run `openspec archive`, commit, or push.

#### Scenario: diverged base blocks with a precise SHA diagnostic

- **WHEN** the worktree `HEAD` and `origin/<branch>` share only an older merge-base so a
  fast-forward is impossible (true divergence, as in #579's `c5bd7b9` vs `dd25659`)
- **THEN** the archive step SHALL block
- **AND** the block reason SHALL name the archive base SHA and the reviewed-head SHA
- **AND** the step SHALL NOT commit or push an archive that could only push via force

### Requirement: Archive step never force-pushes to reconcile a divergence

The pre-merge OpenSpec archive step SHALL NOT issue a force push (`git push --force` or
`--force-with-lease`) to reconcile a divergence between a local archive commit and the
remote branch head. A non-fast-forward push result SHALL be treated as a block signal —
surfaced with a `push-failed` blocker — never as a trigger to overwrite the remote head.

#### Scenario: non-fast-forward archive push blocks, is never forced

- **WHEN** the archive push to `origin/<branch>` is rejected non-fast-forward
- **THEN** the step SHALL block with a push-failure reason
- **AND** SHALL NOT retry the push with `--force` or `--force-with-lease`
- **AND** the reviewed head on the remote SHALL remain unmodified
