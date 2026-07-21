# openspec-integration — deltas for pre-merge-archive-fail-closed (#467)

## ADDED Requirements

### Requirement: Pre-merge SHALL NOT advance while the PR head carries an active OpenSpec change it introduced

Pre-merge SHALL evaluate a head-side active-change guard after the archive step and before advancing out of the stage. The guard SHALL compute, from the pull request's changed-file list for the current head (the `getPrDiff`/`diffFilePaths` seam, not the local worktree filesystem): the set of change ids appearing as `openspec/changes/<id>/…` with `<id>` other than `archive`, minus the set appearing as `openspec/changes/archive/<id>/…`. When that difference is non-empty, pre-merge SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, SHALL name every remaining change id and the expected remedy (`openspec archive <id>`), and SHALL return `{ advanced: false, status: "blocked" }`. Because the guard reads only pull-request data, it SHALL behave identically on a first run, on a run resumed after `pipeline override`, in a fresh process, and when the worktree is absent.

#### Scenario: change introduced by the PR is still active at head

- **WHEN** the pre-merge guard evaluates a PR whose changed-file list contains `openspec/changes/foo/proposal.md`
- **AND** the list contains no `openspec/changes/archive/foo/…` path
- **THEN** pre-merge SHALL block with type `openspec-invalid`
- **AND** the blocking reason SHALL name `foo`
- **AND** pre-merge SHALL NOT advance to the next stage

#### Scenario: change was archived on the branch

- **WHEN** the changed-file list contains `openspec/changes/archive/foo/proposal.md` and no active `openspec/changes/foo/…` path
- **THEN** the guard SHALL NOT block and pre-merge SHALL continue unchanged

#### Scenario: PR touches no OpenSpec changes

- **WHEN** the changed-file list contains no `openspec/changes/` paths
- **THEN** the guard SHALL NOT block and pre-merge SHALL continue unchanged

#### Scenario: override-resumed run is guarded identically

- **WHEN** a run blocked at the pre-merge delta review is resumed by `pipeline override <N> "<key>: <reason>"`
- **AND** the PR still introduces an unarchived `openspec/changes/<id>/` path
- **THEN** the resumed pre-merge SHALL run the archive step and the head-side guard exactly as the non-resumed path does
- **AND** SHALL NOT reach `ready-to-deploy` while the change is active

---

### Requirement: The archive step SHALL fail closed when its preconditions cannot be evaluated

`maybeArchiveOpenspec` SHALL return `null` (continue) only when it has positively established that there is nothing to archive. When the candidate probe `git diff --name-only origin/<base>...HEAD` exits non-zero, the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, using a reason naming the failed git command and its stderr, and SHALL return a blocked outcome — it SHALL NOT treat a failed probe as "no candidates". When the worktree for the issue cannot be found on disk while the OpenSpec flow is active and the pull request's changed-file list contains at least one `openspec/changes/<id>/` path, the step SHALL block with stage `pre-merge` and type `needs-human`, naming the missing worktree; when the pull request contains no such path, the missing worktree SHALL remain a non-blocking skip.

#### Scenario: candidate probe fails

- **WHEN** `maybeArchiveOpenspec` runs and the `git diff --name-only origin/<base>...HEAD` probe exits non-zero
- **THEN** the step SHALL call `setBlocked` with type `openspec-invalid`
- **AND** the reason SHALL name the git failure
- **AND** the step SHALL return `{ advanced: false, status: "blocked" }` rather than `null`

#### Scenario: worktree missing while the PR introduces a change

- **WHEN** the worktree for the issue is not found on disk
- **AND** the OpenSpec flow is active for the repository
- **AND** the pull request's changed-file list contains `openspec/changes/<id>/…`
- **THEN** the step SHALL block with type `needs-human` naming the missing worktree

#### Scenario: worktree missing with no OpenSpec change in the PR

- **WHEN** the worktree is not found on disk and the pull request contains no `openspec/changes/` path
- **THEN** the step SHALL return `null` and pre-merge SHALL continue unchanged

#### Scenario: probe succeeds with no candidates

- **WHEN** the probe exits zero and yields no active change directories
- **THEN** the step SHALL return `null` and pre-merge SHALL continue unchanged

---

### Requirement: A failed `openspec archive` SHALL block pre-merge with the CLI output surfaced verbatim

When `openspec archive <id>` exits non-zero (for example because a `## MODIFIED Requirements` header in the change's delta does not exist in the living spec, which the CLI reports as a header-not-found error), the pre-merge stage SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, SHALL include the change id and the CLI's output verbatim in the blocking reason, SHALL return `{ advanced: false, status: "blocked" }`, and SHALL NOT advance toward `ready-to-deploy` with the change left active.

#### Scenario: archive fails on a retitled MODIFIED requirement

- **WHEN** `openspec archive <id>` exits non-zero with output reporting that a requirement header was not found in the living spec
- **THEN** pre-merge SHALL block with type `openspec-invalid`
- **AND** the blocking reason SHALL contain the change id and the CLI output verbatim
- **AND** the item SHALL NOT reach `ready-to-deploy`

---

### Requirement: The pre-merge archive decision SHALL be recorded as run evidence

Each pre-merge invocation that evaluates the archive step SHALL record one run event capturing the decision and its reason: archived (naming the change ids), skipped (with a reason of `no-candidates` or `openspec-inactive`), or blocked (with the blocking reason). The event SHALL be written to the run's `events.jsonl` so that a skipped archive is diagnosable after the fact from run artifacts alone.

#### Scenario: skip is recorded

- **WHEN** the archive step returns `null` because no active change candidates exist
- **THEN** a run event SHALL record the skip with reason `no-candidates`

#### Scenario: archive is recorded

- **WHEN** the archive step archives one or more changes and pushes the archive commit
- **THEN** a run event SHALL record the archived change ids
