# worktree-lifecycle Specification

## Purpose
How the pipeline isolates each issue's work in a dedicated git worktree, bounds concurrency to active work, serializes runs with a PID lock, honors an emergency kill-switch, and bootstraps the GitHub labels the state machine depends on. (Removal of merged-PR worktrees is refined by `worktree-stale-cleanup`.)
## Requirements
### Requirement: Deterministic worktree path and branch naming
Each issue SHALL get a worktree at `<repo>/<cfg.worktree_root>/pipeline-<issueN>-<slug>` on branch `pipeline/<issueN>-<slug>`, where `<slug>` is a URL-safe, length-bounded slug of the issue title.

#### Scenario: naming
- **WHEN** a worktree is created for issue 42 with a slugged title
- **THEN** its path SHALL be `<repo>/<worktree_root>/pipeline-42-<slug>` and its branch SHALL be `pipeline/42-<slug>`

### Requirement: Concurrency gated on active worktrees only
`createWorktree` SHALL refuse (throw) when the count of *active* worktrees is at `cfg.max_concurrent_worktrees`. A worktree counts as active only when its issue is open on GitHub AND does not carry `pipeline:ready-to-deploy`; closed issues and terminal (ready-to-deploy) ones are excluded. On a `gh` lookup failure a worktree is treated as active (fail-safe). All other callers that need only the path of a known-issue worktree SHALL use `getOnDiskForIssue` rather than routing through `listActive`.

#### Scenario: terminal worktrees don't count
- **WHEN** several on-disk worktrees belong to issues labeled `pipeline:ready-to-deploy`
- **THEN** they SHALL be excluded from the active count used to gate creation

#### Scenario: at capacity
- **WHEN** the active worktree count equals `cfg.max_concurrent_worktrees` and a new worktree is requested
- **THEN** `createWorktree` SHALL throw a capacity error rather than create another

#### Scenario: non-capacity callers do not trigger active-state lookups
- **WHEN** the pipeline resolves the worktree path for a known issue outside of `createWorktree` or `sweepMergedWorktrees`
- **THEN** no `gh` call SHALL be issued to determine whether that or any other worktree is active

### Requirement: Worktree created off the latest base; stale path reclaimed
`createWorktree` SHALL fetch and branch off the latest `origin/<base_branch>`. Before creating the new worktree, the pipeline SHALL reclaim same-issue managed worktrees and clear a colliding directory at the target path **only when reclaim safety checks pass** (see Requirement: Create-time reclaim SHALL share operator remove safety). When reclaim is refused, `createWorktree` SHALL abort without creating a new worktree and without destroying the existing worktree or branch. After a git worktree is successfully created, the pipeline SHALL: (1) write the `node_modules` staging exclusion to `.git/info/exclude` inside the worktree, (2) remove any pre-existing `node_modules` symlink at the worktree root and log the removal, and (3) execute the dependency install step (as specified in `worktree-dependency-install`) before control returns to the caller, so that every worktree is fully bootstrapped and runnable from the moment it is created.

#### Scenario: clean stale path is reclaimed
- **WHEN** a directory already exists at the target worktree path
- **AND** the candidate is a managed worktree (or path collision under the managed root) with a clean workdir and no local-only commits
- **THEN** it SHALL be removed before the new worktree is created off `origin/<base_branch>`

#### Scenario: dirty stale path is not force-reclaimed
- **WHEN** a managed worktree already exists for the same issue (or at the target path)
- **AND** `git status --porcelain` in that worktree returns non-empty output
- **THEN** `createWorktree` SHALL NOT remove the worktree or delete its local branch
- **AND** SHALL abort with an error naming the dirty condition
- **AND** no new worktree SHALL be created at the target path for this call

#### Scenario: node_modules local exclude written during bootstrap
- **WHEN** a worktree is freshly created for an issue
- **THEN** the pipeline SHALL write the pattern `node_modules` to `.git/info/exclude` inside the worktree before any stage or harness runs
- **AND** subsequent `git add` commands in that worktree SHALL not stage any `node_modules` entry

#### Scenario: pre-existing node_modules symlink removed during bootstrap
- **WHEN** a `node_modules` symlink exists at the worktree root at bootstrap time (e.g., left by a prior aborted run)
- **THEN** the pipeline SHALL remove the symlink via `fs.unlink` and emit a log message identifying the removed path
- **AND** the symlink SHALL NOT be present when the dependency install step or any harness runs

#### Scenario: node_modules directory is not removed during bootstrap
- **WHEN** a `node_modules` directory (not a symlink) exists at the worktree root at bootstrap time
- **THEN** the pipeline SHALL NOT remove it
- **AND** SHALL treat it as a legitimately-installed dependency tree and skip the install step per the idempotency rule in `worktree-dependency-install`

#### Scenario: worktree is dependency-installed before first use
- **WHEN** a worktree is freshly created for an issue
- **THEN** the dependency install step SHALL run inside that worktree before `createWorktree` returns
- **AND** all subsequent stages SHALL be able to invoke binaries that the install step provides

### Requirement: PID-based lock with stale recovery
A run SHALL hold a per-domain (optionally per-issue) lock at `/tmp/pipeline-<domain>[-<issueN>].lock`, acquired with an atomic create-or-fail. If the lock file exists, its PID SHALL be probed; a dead or invalid PID SHALL be treated as stale, removed, and the lock re-acquired.

#### Scenario: stale lock recovered
- **WHEN** the lock file holds a PID for a process that is no longer running
- **THEN** the lock SHALL be reclaimed and the run SHALL proceed

#### Scenario: live lock respected
- **WHEN** the lock file holds a PID of a running process
- **THEN** acquisition SHALL fail and the new run SHALL not proceed concurrently

### Requirement: Kill switch halts execution
When the file `/tmp/pipeline-<domain>.disabled` exists, the pipeline SHALL exit without running any stage.

#### Scenario: kill switch active
- **WHEN** `/tmp/pipeline-<domain>.disabled` exists at the start of a run
- **THEN** the pipeline SHALL exit without dispatching any stage

### Requirement: Pipeline labels are bootstrapped idempotently
`ensurePipelineLabels` SHALL idempotently create the labels the state machine relies on: `blocked`, the `harness:*` labels, and one `pipeline:<stage>` label per entry in `STAGES`. Re-running SHALL create no duplicates.

#### Scenario: labels ensured
- **WHEN** `ensurePipelineLabels` runs against a repo missing some pipeline labels
- **THEN** the missing labels SHALL be created and already-present labels SHALL be left unchanged

### Requirement: Create-time reclaim SHALL share operator remove safety
Before `createWorktree` destroys any same-issue managed worktree (retry, title/slug change, multi-stale accumulation) or clears a colliding path at the computed target, the pipeline SHALL apply the same safety policy as `removeWorktreeForIssue` / `worktree-per-run-removal` **without force**: (1) when the path is on disk, treat a dirty workdir as blocking; (2) evaluate local-only (unpushed) commits with the same tier results (`true` / `"unverifiable"` / `null` / clean); (3) refuse reclaim on any blocking result and leave the worktree and local branch intact. Reclaim SHALL NOT pass an implicit force flag that discards dirty work or bypasses local-only verification failure. Clean candidates with no local-only commits MAY be removed so create can proceed. Records with `underManagedRoot === false` SHALL continue to be skipped (never force-reclaimed). The safety policy SHALL be single-sourced with operator remove so the two paths cannot silently diverge.

Reclaim SHALL preflight **every** same-issue managed candidate and target-path collision candidate with the safety policy **before** invoking any worktree or branch deletion for any candidate. If any candidate fails preflight, `createWorktree` SHALL abort with no reclaim mutations on any candidate (including earlier candidates that would have passed in isolation).

Automatic reclaim mutation SHALL be race-safe relative to the preflight verdict: (1) worktree deletion SHALL use non-force `git worktree remove` so a workdir that becomes dirty after preflight refuses deletion; (2) local branch deletion SHALL be conditioned on the branch tip OID captured at preflight (compare-and-delete, e.g. `git update-ref -d`), not an unconditional `git branch -D`; (3) a changed branch tip or failed non-force remove SHALL be treated as a reclaim refusal. Reclaim SHALL NOT use `git worktree remove --force` for automatic create-time reclaim.

#### Scenario: Dirty managed worktree blocks reclaim on retry
- **WHEN** issue N already has a managed active worktree with uncommitted changes
- **AND** `createWorktree` runs again for issue N (retry / re-run)
- **THEN** the pipeline SHALL NOT invoke `git worktree remove` or branch deletion for that worktree
- **AND** `createWorktree` SHALL fail with an error that identifies the dirty condition and the issue or path
- **AND** the existing worktree directory and branch SHALL remain

#### Scenario: Local-only commits block reclaim on slug change
- **WHEN** issue N has a managed worktree on branch `pipeline/N-<old-slug>` with commits not pushed to the remote
- **AND** the issue title changes so the new slug differs
- **AND** `createWorktree` runs for issue N with the new slug
- **THEN** reclaim of the old-slug worktree SHALL be refused
- **AND** no `git worktree remove` / branch deletion SHALL run for that branch
- **AND** `createWorktree` SHALL fail with an error naming the local-only condition

#### Scenario: Unverifiable local-only state blocks reclaim
- **WHEN** local-only commit verification for a reclaim candidate returns `"unverifiable"` (or a hard verification failure / `null`)
- **THEN** reclaim SHALL refuse without mutating the worktree or branch
- **AND** `createWorktree` SHALL fail with an error naming the verification condition

#### Scenario: Clean managed worktree is reclaimed so create proceeds
- **WHEN** issue N has a managed active worktree that is clean and has no local-only commits
- **AND** `createWorktree` runs for issue N
- **THEN** the pipeline MAY remove that worktree and its local branch
- **AND** SHALL create a fresh worktree off `origin/<base_branch>` at the current slug path

#### Scenario: Out-of-managed-root worktree is never reclaimed
- **WHEN** a Git-registered worktree shares issue N's pipeline branch name but has `underManagedRoot === false`
- **AND** `createWorktree` runs for issue N
- **THEN** that worktree SHALL NOT be removed or branch-deleted by reclaim

#### Scenario: Safety policy is shared with operator remove
- **WHEN** the dirty or local-only tier outcomes are defined for `removeWorktreeForIssue`
- **THEN** create-time reclaim SHALL apply the same blocking outcomes as operator remove without `--force`
- **AND** a unit test suite SHALL fail if reclaim can call the destructive remove seam while dirty or local-only checks would block

#### Scenario: Later unsafe candidate does not destroy earlier clean candidates
- **WHEN** issue N has two managed active worktrees
- **AND** the first candidate is clean with no local-only commits
- **AND** the second candidate is dirty, local-only, unverifiable, or otherwise blocking
- **AND** `createWorktree` runs for issue N
- **THEN** reclaim preflight SHALL fail on the blocking candidate
- **AND** the pipeline SHALL NOT remove the earlier clean worktree or delete its branch
- **AND** `createWorktree` SHALL abort without creating a new worktree

#### Scenario: Late dirty workdir refuses race-safe reclaim
- **WHEN** a reclaim candidate passed preflight as clean
- **AND** non-force `git worktree remove` fails because the workdir became dirty after preflight
- **THEN** reclaim SHALL abort with an error naming the refused remove
- **AND** SHALL NOT delete the local branch as part of that reclaim attempt

#### Scenario: Branch tip change refuses race-safe branch delete
- **WHEN** a reclaim candidate's branch tip OID was captured at preflight
- **AND** the tip differs when mutation would run (or compare-and-delete fails)
- **THEN** reclaim SHALL refuse without unconditional `git branch -D`
- **AND** `createWorktree` SHALL fail with an error naming the tip-change condition

### Requirement: Capacity gate remains issue-scoped and same-issue reclaim safe after park-release

`createWorktree` SHALL continue to refuse when the count of *other* active managed worktrees (open GitHub issues that are not `pipeline:ready-to-deploy`, per `listActive`) is at `cfg.max_concurrent_worktrees`. The current issue number SHALL NOT count against itself. Same-issue managed reclaim SHALL still run before the capacity check so a retry or resume cannot be blocked by the issue's own prior worktree records. Park-released issues with no on-disk managed worktree SHALL not contribute to that count (they are absent from `listOnDisk` / `listActive`). Capacity refusal SHALL throw or return a machine-distinguishable capacity error (stable message prefix or typed identity) so admission disposition can treat pure capacity separately from other create failures.

#### Scenario: Park-released siblings do not fill capacity

- **WHEN** `max_concurrent_worktrees` is 2
- **AND** two other issues previously held managed worktrees but those worktrees were park-released and are absent from disk
- **AND** `createWorktree` runs for a third issue
- **THEN** capacity counting SHALL treat otherActive as 0 from those released issues
- **AND** create SHALL NOT fail solely for capacity on account of the released issues

#### Scenario: Same-issue retry at cap 1 still reclaims self

- **WHEN** `max_concurrent_worktrees` is 1
- **AND** issue N already has a clean managed worktree with no local-only commits
- **AND** `createWorktree` runs again for issue N
- **THEN** same-issue reclaim MAY remove issue N's prior worktree
- **AND** capacity SHALL NOT refuse solely because issue N's own pre-reclaim record was the only active slot

#### Scenario: True other-active capacity still refuses create

- **WHEN** other open non-ready-to-deploy issues each still have on-disk managed worktrees totaling `max_concurrent_worktrees`
- **AND** `createWorktree` runs for a different issue
- **THEN** create SHALL refuse with a capacity error rather than creating another worktree

#### Scenario: Capacity error is distinguishable from generic create failure

- **WHEN** create refuses for capacity
- **THEN** the error or result SHALL be machine-distinguishable as capacity (stable identity)
- **AND** SHALL remain distinct from dirty-reclaim refusal and git worktree-add failures

### Requirement: Create, reclaim, and reuse decisions SHALL consume worktree reconcile actions

`createWorktree` and other lifecycle entry points SHALL obtain retain/reclaim/recreate decisions
from the worktree reconcile-and-converge surface (or a thin wrapper around it) rather than
re-encoding independent dirty/local-only/poisoned-tree branches at each call site. Automatic reclaim
mutation safety (non-force remove, compare-and-delete branch tip) remains as already required;
reconcile SHALL NOT weaken those guards.

#### Scenario: Lifecycle entry uses reconcile rather than a private decision tree

- **WHEN** `createWorktree` runs for an issue that may already have a managed worktree or path
  collision
- **THEN** retain/reclaim/recreate selection SHALL come from the shared worktree reconcile surface
- **AND** a dirty or local-only candidate SHALL still refuse reclaim without force

#### Scenario: Reconcile refuse blocks create without destroying the tree

- **WHEN** reconcile returns refuse-unsafe-remove for the existing managed candidate
- **THEN** `createWorktree` SHALL abort without removing that worktree or its branch
- **AND** SHALL NOT create a second worktree at the target path in the same call

