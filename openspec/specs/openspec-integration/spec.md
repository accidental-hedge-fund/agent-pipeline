# openspec-integration Specification

## Purpose
The opt-in OpenSpec flow: auto-detect a repo's `openspec/` workspace, plan spec-first (author a change — proposal, tasks, spec deltas — instead of a freeform plan), validate it structurally, and at finalize archive the change into the living specs. The integration must leave the freeform (non-OpenSpec) path unchanged on repos that don't use it. (Propagation of spec deltas into the planning/implement/fix/review prompts is refined by `openspec-context-propagation`; the standalone `init` command is `init-command`.)
## Requirements
### Requirement: Activation is auto-detected and overridable
Whether the OpenSpec flow runs SHALL be governed by `cfg.openspec.enabled` (`auto` | `on` | `off`): `on` always active, `off` never, `auto` active only when an `openspec/` workspace exists (`isInitialized`). `shouldPlanWithOpenspec` and `isActive` encode this.

#### Scenario: auto with a workspace
- **WHEN** `openspec.enabled` is `auto` and the repo has an `openspec/` directory
- **THEN** the OpenSpec flow SHALL be active

#### Scenario: auto without a workspace
- **WHEN** `openspec.enabled` is `auto` and the repo has no `openspec/` directory
- **THEN** the OpenSpec flow SHALL be inactive and planning SHALL use the freeform path unchanged

#### Scenario: forced off
- **WHEN** `openspec.enabled` is `off`
- **THEN** the OpenSpec flow SHALL never activate regardless of an `openspec/` directory

### Requirement: Spec-first planning authors a change
When the OpenSpec flow is active, planning SHALL author an OpenSpec change (a `proposal.md`, `tasks.md`, and spec deltas under `openspec/changes/<id>/`) rather than a freeform plan, and commit those intent artifacts.

#### Scenario: change authored
- **WHEN** planning runs with the OpenSpec flow active
- **THEN** an `openspec/changes/<id>/` directory SHALL be created with proposal/tasks/spec-delta artifacts and committed

### Requirement: Structural validation gates the change
The change SHALL be validated with `openspec validate` at draft and again after revision; a validation failure SHALL block rather than advance.

#### Scenario: invalid change blocks
- **WHEN** the authored or revised change fails `openspec validate`
- **THEN** the stage SHALL block rather than proceed to implementation

### Requirement: Archive into living specs at finalize

At pre-merge the change SHALL be archived (`openspec archive`) — folding its spec deltas into `openspec/specs/` and moving the change under `openspec/changes/archive/` — and `openspec validate --all` SHALL pass before the item reaches `ready-to-deploy`. Before calling `openspec archive`, the pre-merge stage SHALL run a consistency guard that blocks a stale-delta archive. The guard SHALL block when ALL of: (1) a non-pipeline commit on the branch changed implementation files in a commit ordered after the last commit that changed the change's `specs/**` (order-aware file-path check), AND (2) the most recent review verdict contains a finding tagged with the structured category `spec-divergence`. The guard SHALL read condition (2) from the structured category marker emitted into the review comment, and SHALL NOT infer divergence by keyword-matching the reviewer's free-text prose.

#### Scenario: archive on finalize when spec and code are consistent

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** the consistency guard does not detect a code-spec divergence
- **THEN** its change SHALL be archived into the living specs and `openspec validate --all` SHALL pass before advancing

#### Scenario: pre-merge blocks when code moved but spec did not and a finding is tagged spec-divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** a non-pipeline commit changed implementation files after the last commit that changed the change's `specs/**`
- **AND** the most recent review verdict contains a finding tagged `category: spec-divergence`
- **THEN** the pre-merge stage SHALL block with a reason naming the stale-delta condition
- **AND** SHALL NOT call `openspec archive`

#### Scenario: pre-merge proceeds when no finding is tagged spec-divergence

- **WHEN** an OpenSpec-active item reaches pre-merge
- **AND** implementation files changed but the change's `specs/**` did not
- **AND** no review finding is tagged `category: spec-divergence` (even if a finding's prose mentions "diverges" or "spec")
- **THEN** the consistency guard SHALL NOT block
- **AND** the archive step SHALL proceed normally

#### Scenario: the consistency guard ignores prose

- **WHEN** the most recent review verdict contains a finding whose body mentions a spec divergence in prose but carries no `category: spec-divergence` marker
- **THEN** the consistency guard SHALL treat it as no divergence flag and SHALL NOT block on that basis

### Requirement: Bootstrap is opt-in
When the flow is active on a repo lacking an `openspec/` workspace, planning SHALL run `openspec init` only if `cfg.openspec.bootstrap` is `true`; otherwise it SHALL block with an actionable message rather than silently proceeding.

#### Scenario: bootstrap enabled
- **WHEN** the flow is active, the repo has no `openspec/`, and `openspec.bootstrap` is `true`
- **THEN** planning SHALL run `openspec init` and commit the new workspace

#### Scenario: missing workspace without bootstrap
- **WHEN** `openspec.enabled` is `on`, the repo has no `openspec/`, and `bootstrap` is `false`
- **THEN** the stage SHALL block with guidance to enable bootstrap or run `openspec init`

### Requirement: Archive step is idempotent across polling iterations

The pre-merge archive step SHALL compute the current active OpenSpec candidates from the branch diff before consulting commit history. If no active change directories remain in the diff, the archive step SHALL be skipped and the gate SHALL proceed to the next check without pushing a new commit or returning `waiting`. If active candidates exist, the gate SHALL invoke `openspec archive` regardless of whether a prior archive commit is found in the branch history.

#### Scenario: no active candidates — step skipped

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains no active change directories (either already archived and removed, or none ever existed)
- **THEN** the gate SHALL skip `openspec archive` entirely
- **AND** SHALL NOT push a new archive commit
- **AND** SHALL return `null` (continue to the next pre-merge check)

#### Scenario: prior archive commit exists but active candidates remain — re-archive

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** the branch diff contains one or more active change directories
- **AND** a prior archive commit for this issue exists in the branch history (e.g., a revert re-introduced a change)
- **THEN** the gate SHALL invoke `openspec archive` for each active candidate
- **AND** SHALL NOT skip based on the prior archive commit alone

#### Scenario: no prior archive commit — archive proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** no archive commit for this issue exists in the branch commit history
- **AND** active change directories are found in the diff
- **THEN** the gate SHALL invoke `openspec archive` for each active change as before

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
- **AND** `git status --porcelain` (run before `openspec archive`) reports dirty files outside `openspec/` paths
- **THEN** the stage SHALL set a pre-merge blocker on the issue
- **AND** SHALL return `{ advanced: false, status: "blocked" }` without invoking `openspec archive`

#### Scenario: commit succeeds — push proceeds normally

- **WHEN** `maybeArchiveOpenspec` is called
- **AND** `openspec archive` succeeds and a non-empty diff is staged
- **AND** `git commit` exits zero
- **THEN** the stage SHALL proceed to `git push origin <branch>` as before
- **AND** the existing push-failure and waiting paths SHALL remain unchanged

### Requirement: Missing OpenSpec CLI blocks pre-merge archive when active changes exist

The pre-merge archive step SHALL require the `openspec` CLI whenever the branch has active
change candidates to archive. When `openspec archive` reports the CLI is unavailable
(`unavailable: true`) and one or more active change directories exist in the branch diff,
the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`, using a
reason that names the missing `openspec` CLI and the affected change id, and SHALL return a
blocked outcome (`{ advanced: false, status: "blocked" }`). The step SHALL NOT return a
non-blocking `null` (skip) in this case, because skipping leaves the active change unarchived
and ships an orphaned `openspec/changes/<id>/` directory to the base branch. When there are
no active candidates, the missing CLI SHALL NOT block — the step SHALL return `null` and
pre-merge SHALL continue unaffected, preserving the behavior of repos with nothing to
archive. This makes the archive step consistent with `doctor` (which already requires the
CLI when OpenSpec is active) and with planning (which blocks with an install hint).

#### Scenario: CLI unavailable with active candidates — blocks

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains one or more active change directories (candidates exist)
- **AND** `openspec archive` for a candidate returns `{ unavailable: true }`
- **THEN** the step SHALL call `setBlocked` with stage `pre-merge` and type `openspec-invalid`
- **AND** the blocking reason SHALL name the missing `openspec` CLI and the affected change id
- **AND** the step SHALL return `{ advanced: false, status: "blocked" }`
- **AND** the step SHALL NOT return `null`
- **AND** the step SHALL NOT push an archive commit

#### Scenario: CLI unavailable with no active candidates — continues unaffected

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains no active change directories (no candidates)
- **THEN** the step SHALL return `null` before invoking the `openspec` CLI
- **AND** SHALL NOT call `setBlocked`
- **AND** pre-merge SHALL continue to the next check unaffected

#### Scenario: CLI available with active candidates — archives as before

- **WHEN** `maybeArchiveOpenspec` is called and OpenSpec is active for the worktree
- **AND** the branch diff contains one or more active change directories (candidates exist)
- **AND** the `openspec` CLI is available
- **THEN** the step SHALL invoke `openspec archive` for each candidate
- **AND** on success SHALL commit and push the archived specs and return a `waiting` outcome
  so CI re-runs (or `null` if the archive produced no diff)
- **AND** on archive failure SHALL block with type `openspec-invalid` as before

### Requirement: OpenSpec planning SHALL commit the project config it creates

OpenSpec planning SHALL leave the worktree free of untracked OpenSpec project config before
implementation and the test gate. When the OpenSpec flow authors a change in an already-initialized
repo, the `openspec` CLI may create or update the project config file `openspec/config.yaml` as a
side effect (its `ensureDefaultConfig` writes the file when absent; `openspec new change` and
`openspec validate` trigger this). After the authoring harness runs and after any OpenSpec-scoped
salvage, the planning stage SHALL commit `openspec/config.yaml` if it exists in the worktree as an
untracked or modified file. The commit SHALL stage only `openspec/config.yaml` (no path outside
`openspec/`), SHALL carry the `Issue:` and `Pipeline-Run:` traceability trailers, and SHALL occur
before the authoring path-constraint verification so the committed config is part of the verified
commit range and satisfies the `allowPattern: /^openspec\//` guard. Additionally, the planning
stage SHALL repeat the config-commit step after each structural-validation call (`validateArtifact`
and `revalidateArtifact`) because those calls also invoke `openspec validate` and can trigger
`ensureDefaultConfig`, leaving `openspec/config.yaml` untracked after the initial commit. When
`openspec/config.yaml` is already tracked and unmodified, each config-commit step SHALL be a no-op
— it SHALL NOT create an empty commit and SHALL NOT error. This step SHALL NOT alter the
`openspec.bootstrap` path, which already commits `config.yaml` via `openspec init` + `git add -A`.

#### Scenario: CLI created config.yaml untracked while the harness committed the change

- **WHEN** the OpenSpec flow is active on an already-initialized repo
- **AND** the authoring harness committed its change under `openspec/changes/<id>/`
- **AND** the `openspec` CLI left `openspec/config.yaml` untracked in the worktree
- **THEN** the planning stage SHALL stage and commit `openspec/config.yaml`
- **AND** after planning completes `git status --porcelain` SHALL report no untracked or modified
  `openspec/config.yaml`
- **AND** the implementation/test-gate phase SHALL NOT see `openspec/config.yaml` as a dirty path

#### Scenario: config-commit is scoped and trailered

- **WHEN** the planning stage commits a leftover `openspec/config.yaml`
- **THEN** the commit diff SHALL contain only `openspec/config.yaml` (no path outside `openspec/`)
- **AND** the commit message SHALL end with `Issue: #<n>` and `Pipeline-Run: <id>` trailers
- **AND** `verifyHarnessCommits` with the authoring `allowPattern: /^openspec\//` SHALL return ok
  for the range that includes this commit

#### Scenario: config.yaml already tracked — no extra commit

- **WHEN** the OpenSpec flow is active
- **AND** `openspec/config.yaml` is already tracked and unmodified after authoring (or the harness
  itself committed it)
- **THEN** the planning stage SHALL create no additional commit for `openspec/config.yaml`
- **AND** the stage SHALL NOT error and SHALL proceed to the path-constraint verification as before

#### Scenario: bootstrap path unchanged

- **WHEN** the OpenSpec flow is active on a repo with no `openspec/` workspace and
  `openspec.bootstrap` is `true`
- **THEN** the bootstrap step SHALL run `openspec init` and commit the new workspace — including
  `openspec/config.yaml` — via `git add -A` in the `chore: openspec init` commit, exactly as today
- **AND** the new config-commit step SHALL be a no-op in this case because `config.yaml` is already
  committed by the bootstrap

#### Scenario: config-commit step is injectable for unit testing

- **WHEN** the config-commit step runs with fake `gitStatus`, `gitAdd`, and `gitCommit` seams
- **AND** the fake `gitStatus` reports `openspec/config.yaml` as untracked
- **THEN** the test SHALL verify `gitAdd` is called with a pathspec restricted to
  `openspec/config.yaml` and `gitCommit` is called with a trailered message
- **AND** when the fake `gitStatus` reports no change for `openspec/config.yaml`, the test SHALL
  verify neither `gitAdd` nor `gitCommit` is called

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

