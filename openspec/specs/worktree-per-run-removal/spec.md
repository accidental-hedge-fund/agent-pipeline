# worktree-per-run-removal Specification

## Purpose
TBD - created by archiving change worktree-merged-cleanup. Update Purpose after archive.

## Requirements

### Requirement: Per-issue worktree removal via flag
The pipeline SHALL accept a `--remove-worktree` flag on `pipeline N` invocations. When supplied, the pipeline SHALL locate the pipeline-managed worktree for issue N by selecting the Git-registered worktree record whose issue identity is N and whose path lies under one of the managed roots resolved per `managed-worktree-resolution` — regardless of which checkout of the shared Git common directory the command is invoked from — remove it (worktree directory deregistered from git AND local branch deleted), and exit without running any pipeline-advance logic. It SHALL NOT recompute the managed root from `cfg.repo_dir` alone. The remote branch SHALL NOT be touched. A worktree that is not Git-registered, or whose path lies under no managed root, SHALL NOT be removed.

#### Scenario: Clean worktree is removed
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a pipeline-managed worktree for issue N exists on disk
- **AND** the worktree has no uncommitted changes (`git status --porcelain` returns empty)
- **THEN** the worktree directory is removed from disk
- **AND** `git worktree list` no longer includes the worktree
- **AND** the local branch `pipeline/<N>-<slug>` is deleted
- **AND** the remote branch is NOT deleted or modified
- **AND** the process exits zero

#### Scenario: Worktree created from a linked checkout is removed from the primary checkout
- **WHEN** a Pipeline worktree for issue N was created from a linked checkout (and therefore carries the pipeline ownership marker per the requirement below) and is registered at `<linked>/<worktree_root>/pipeline-N-<slug>` on branch `pipeline/N-<slug>`
- **AND** the operator invokes `pipeline N --remove-worktree` from the primary checkout of the same Git common directory
- **THEN** that worktree SHALL be resolved and removed
- **AND** the reported `worktree` path SHALL be `<linked>/<worktree_root>/pipeline-N-<slug>`
- **AND** the reported `branch` SHALL be `pipeline/N-<slug>`

#### Scenario: Removal works from a third linked checkout
- **WHEN** the command is invoked from a linked checkout that is neither the primary checkout nor the checkout under which the worktree was created
- **THEN** the same worktree record SHALL be resolved and removed

#### Scenario: A developer-owned worktree on a pipeline branch is never removed
- **WHEN** a worktree on branch `pipeline/N-<slug>` is registered at a path under no managed root
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** no `git worktree remove` and no `git branch -D` SHALL be invoked
- **AND** the result SHALL report the not-found condition

#### Scenario: A similarly named unregistered directory is never removed
- **WHEN** a directory named `pipeline-N-<slug>` exists under a managed root but is absent from `git worktree list --porcelain` output
- **THEN** it SHALL NOT be selected for removal

#### Scenario: No worktree found exits non-zero
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** no pipeline-managed worktree for issue N is registered under any managed root
- **THEN** an error is printed naming issue N and the managed roots that were searched
- **AND** no removal operation is invoked
- **AND** the process exits non-zero

#### Scenario: Command works regardless of PR merge state
- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a worktree for issue N is present on disk
- **AND** the PR for issue N is open (not yet merged)
- **THEN** the worktree is removed (same behavior as if the PR were merged)
- **AND** the process exits zero (assuming the worktree is clean)

### Requirement: Dirty worktree blocks removal without --force
The pipeline SHALL NOT silently destroy uncommitted work. If the worktree for issue N has uncommitted local changes (tracked or untracked modifications) and `--force` is not supplied, the pipeline SHALL exit non-zero and report the dirty state. The worktree SHALL NOT be removed.

#### Scenario: Dirty worktree without --force exits non-zero
- **WHEN** the operator invokes `pipeline N --remove-worktree` without `--force`
- **AND** a worktree for issue N exists
- **AND** `git status --porcelain` in the worktree returns non-empty output
- **THEN** the worktree is NOT removed
- **AND** the local branch is NOT deleted
- **AND** an error is printed indicating uncommitted changes
- **AND** the process exits non-zero

#### Scenario: Dirty worktree with --force is removed with warning
- **WHEN** the operator invokes `pipeline N --remove-worktree --force`
- **AND** a worktree for issue N exists with uncommitted changes
- **THEN** a warning is logged indicating the worktree had uncommitted changes
- **AND** the worktree directory is removed
- **AND** the local branch is deleted
- **AND** the remote branch is NOT touched
- **AND** the process exits zero

---

### Requirement: JSON output for machine-readable consumers
When `--json` is combined with `--remove-worktree`, the pipeline SHALL emit a single JSON object to stdout (and nothing else) with at least the following fields: `removed` (boolean), `dirty` (boolean), `branch` (string or null), `worktree` (string or null), `error` (string or null). The exit code rules are unchanged.

#### Scenario: Successful removal with --json
- **WHEN** the operator invokes `pipeline N --remove-worktree --json`
- **AND** the worktree is clean and is removed
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `true`, `dirty` is `false`, `error` is `null`
- **AND** `branch` is the branch name that was deleted
- **AND** `worktree` is the path that was removed
- **AND** the process exits zero

#### Scenario: Dirty worktree with --json (no --force)
- **WHEN** the operator invokes `pipeline N --remove-worktree --json` without `--force`
- **AND** the worktree is dirty
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `false`, `dirty` is `true`
- **AND** `error` describes the uncommitted-changes condition
- **AND** the process exits non-zero

#### Scenario: Not-found with --json
- **WHEN** the operator invokes `pipeline N --remove-worktree --json`
- **AND** no worktree for issue N exists
- **THEN** stdout contains exactly one JSON object
- **AND** `removed` is `false`, `worktree` is `null`, `branch` is `null`
- **AND** `error` describes the not-found condition
- **AND** the process exits non-zero

---

### Requirement: Kill-switch bypass
`pipeline N --remove-worktree` SHALL bypass the kill switch. A kill switch active during a stuck run is precisely when operators most need to clean up worktrees; blocking this action with the kill switch would prevent recovery.

#### Scenario: --remove-worktree succeeds despite active kill switch
- **WHEN** the kill switch file `/tmp/pipeline-<domain>.disabled` exists
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** the removal proceeds normally (not blocked by the kill switch)

---

### Requirement: --force requires --remove-worktree
Using `--force` without `--remove-worktree` SHALL be a usage error. The `--force` modifier is scoped to the per-issue removal mode and has no meaning in other pipeline modes.

#### Scenario: --force alone exits with usage error
- **WHEN** the operator invokes `pipeline N --force` without `--remove-worktree`
- **THEN** the process exits non-zero with a usage error naming the invalid flag combination
- **AND** no pipeline-advance logic runs

---

### Requirement: Unit-testable via injectable deps
The per-issue removal logic SHALL be implemented with an injectable `RemoveWorktreeDeps` interface (following the `SweepDeps` / `CreateWorktreeDeps` pattern). Unit tests SHALL exercise all outcomes (clean removal, dirty-without-force, dirty-with-force, not-found) using fake deps with no real git, network, or filesystem calls.

#### Scenario: All outcomes exercised without real I/O
- **WHEN** the test suite runs `removeWorktreeForIssue` with fake deps
- **THEN** each outcome path (removed, blocked-dirty, forced-dirty, not-found) is covered by at least one test
- **AND** no real `git` subprocess, filesystem write, or network call is made

### Requirement: An ambiguous managed match SHALL fail closed
When more than one Git-registered, managed-root worktree record matches issue N, the pipeline SHALL refuse the removal, SHALL NOT invoke any removal or branch-deletion operation, and SHALL report an error naming every candidate path and directing the operator to remove the intended worktree explicitly. The pipeline SHALL NOT apply a tie-break heuristic to pick one candidate.

#### Scenario: Two managed candidates block removal
- **WHEN** worktrees for issue N are registered under two different checkouts' managed roots
- **AND** the operator invokes `pipeline N --remove-worktree`
- **THEN** `removed` SHALL be `false` and `worktree` SHALL be `null`
- **AND** the error SHALL name both candidate paths
- **AND** neither `git worktree remove` nor `git branch -D` SHALL be invoked
- **AND** the process exits non-zero

#### Scenario: Ambiguity is not bypassable with --force
- **WHEN** the same invocation adds `--force`
- **THEN** the removal SHALL still be refused with the same ambiguity error

---

### Requirement: Existing removal safety behavior SHALL be preserved for cross-checkout records
Resolving a worktree through the managed-root set SHALL NOT change any subsequent safety behavior. For a cross-checkout record, the dirty-worktree block, the local-only-commit tiers (definite block, `unverifiable` soft block, verification-failure hard block), the `--force` semantics, the stale-registration path, the `--json` field set, and the exit-code rules SHALL be identical to those applied to a worktree under the invoking checkout's own root.

#### Scenario: Dirty cross-checkout worktree still blocks without --force
- **WHEN** a cross-checkout worktree for issue N has uncommitted changes
- **AND** the operator invokes `pipeline N --remove-worktree` without `--force`
- **THEN** the worktree SHALL NOT be removed
- **AND** the reported result SHALL be identical in shape and values to the same case under the invoking checkout's own root

#### Scenario: Local-only commits still block a cross-checkout worktree
- **WHEN** a cross-checkout worktree's branch has commits not present on the remote
- **THEN** the removal SHALL be refused even with `--force`

#### Scenario: Single-checkout behavior is unchanged
- **WHEN** the repository has exactly one registered checkout
- **THEN** every removal outcome (clean removal, dirty-without-force, dirty-with-force, stale registration, not-found) SHALL return the same result object as before this change

---

### Requirement: A cross-checkout removal candidate SHALL require proof of pipeline ownership
Git registration, path placement under a managed root, and branch naming alone SHALL NOT be treated as proof that the pipeline created a worktree found under a *different* checkout's managed root than the one `--remove-worktree` was invoked from — a developer's own linked checkout of the same Git common directory can independently register a nested worktree matching the same path and branch conventions by coincidence. `createWorktree` SHALL stamp every worktree it creates with a durable, per-worktree ownership marker stored outside the working tree (so it is invisible to `git status` and is removed automatically when the worktree is deregistered). Before removing an on-disk candidate whose managed root differs from the invoking checkout's own root, the pipeline SHALL verify this marker is present and SHALL refuse the removal — invoking no `git worktree remove` or `git branch -D` — when it is absent. This gate SHALL NOT apply to a candidate under the invoking checkout's own managed root, preserving pre-existing single-checkout trust and behavior exactly.

#### Scenario: Cross-checkout worktree without the ownership marker is refused
- **WHEN** a worktree matching issue N's branch and directory-naming convention is registered under a linked checkout's managed root, other than the invoking checkout's own root
- **AND** that worktree was not created by `createWorktree` and therefore carries no ownership marker
- **AND** the operator invokes `pipeline N --remove-worktree` from a different checkout
- **THEN** the removal SHALL be refused
- **AND** neither `git worktree remove` nor `git branch -D` SHALL be invoked
- **AND** the error SHALL name the worktree path and state that no pipeline ownership marker was found
- **AND** the process exits non-zero

#### Scenario: A cross-checkout worktree created by the pipeline carries the marker and is removed
- **WHEN** `createWorktree` created the worktree for issue N from a linked checkout
- **AND** the operator invokes `pipeline N --remove-worktree` from a different checkout of the same Git common directory
- **THEN** the ownership marker SHALL be present
- **AND** the removal SHALL proceed exactly as described in "Worktree created from a linked checkout is removed from the primary checkout"

#### Scenario: The ownership gate does not apply to a same-checkout candidate
- **WHEN** the matched worktree's managed root is the invoking checkout's own root
- **THEN** the pipeline SHALL NOT consult the ownership marker before proceeding to the existing dirty/local-commits/force checks

### Requirement: Every production worktree-removal path SHALL use evaluateRemoveSafety or a written exemption

Every production call site that removes a pipeline-managed worktree SHALL either:

1. invoke `evaluateRemoveSafety` (directly or via a single shared wrapper that always evaluates it
   once before mutation), or
2. carry a written source exemption comment stating why terminal force-remove is safe at that site,
   and a regression test that asserts the exemption remains intentional.

Sites that historically force-removed without the ladder (including `auto_recover` and
`deploy_ready`) SHALL be brought under this rule. Operator `--remove-worktree` behavior with
optional `--force` remains as already specified.

#### Scenario: auto_recover removal is safety-gated

- **WHEN** `auto_recover` removes a managed worktree as part of recovery
- **THEN** the path SHALL evaluate `evaluateRemoveSafety` (or the shared wrapper) before mutation
- **AND** a dirty or local-only tree without force authority SHALL NOT be destroyed

#### Scenario: deploy_ready removal is safety-gated

- **WHEN** `deploy_ready` removes a managed worktree after ready-to-deploy
- **THEN** the path SHALL evaluate `evaluateRemoveSafety` (or the shared wrapper) before mutation
- **OR** SHALL carry a written exemption plus a regression test that documents why force-remove is
  safe in that terminal state

#### Scenario: Removal call-site registry test fails on unguarded new paths

- **WHEN** the unit test suite enumerates production worktree-removal call sites
- **THEN** each site SHALL be classified as ladder-backed or explicitly exempt
- **AND** an unguarded site without exemption SHALL fail the test

### Requirement: Post-squash-merge unreachability SHALL NOT be classified as a git/network/auth failure

The shared remove-safety ladder SHALL classify the post-squash-merge condition — remote head branch deleted, pre-merge commits not reachable from the configured base — as squash-merge unreachability (the existing unverifiable / `--force` tier), not as a git/network/auth hard failure. A successful observation that the remote head ref is absent, followed by a reachability check against `origin/<base>` that shows unreachable commits or cannot prove those commits are in the base, SHALL use that squash-merge classification. The ladder SHALL reserve git/network/auth wording for an actual connectivity, authentication, or git-command failure that prevents observing whether the remote head exists.

Automatic park-release and ready-to-deploy removal SHALL consume this classification. They SHALL NOT map the squash-merge condition to `commit verification failed (git/network/auth error)` or tell the operator to check connectivity or retry.

#### Scenario: Remote-deleted unreachable commits are unverifiable, not git/network/auth

- **WHEN** local-only verification observes that the remote head branch is absent
- **AND** pre-merge commits are not reachable from `origin/<base>` (or that reachability check cannot prove they are in the base)
- **AND** the git transport succeeded enough to observe the missing remote head
- **THEN** the shared ladder SHALL classify the result as squash-merge unreachability
- **AND** SHALL NOT classify it as a git/network/auth hard failure
- **AND** operator-visible text from automatic removal SHALL NOT contain `commit verification failed (git/network/auth error)`

#### Scenario: True transport failure remains git/network/auth

- **WHEN** local-only verification cannot observe whether the remote head exists because `ls-remote` (or the equivalent transport) fails with a git, network, or auth error
- **AND** bound merge-result proof is absent
- **THEN** the shared ladder MAY retain the worktree with a git/network/auth reason
- **AND** that reason SHALL still not be used when the remote-absent squash-merge condition was successfully observed

#### Scenario: Expected non-ancestry exit is not a transport failure

- **WHEN** `ls-remote` succeeds and the remote head ref is empty
- **AND** the reachability probe reports non-ancestry with documented exit status 1 (or non-empty `git log origin/<base>..HEAD`)
- **THEN** the shared ladder SHALL classify the result as squash-merge unreachability
- **AND** SHALL NOT classify exit status 1 as a git/network/auth hard failure
- **AND** SHALL still classify a failed `ls-remote` observation as transport/auth when bound proof is absent

### Requirement: Automatic ready-to-deploy removal SHALL honor bound merge-result proof

The shared automatic-removal path used at `pipeline:ready-to-deploy` and by park-release SHALL accept bound merge-result proof (same issue number, same PR number, same base branch, same proven `merge_result_oid` contained in `origin/<base>`, and current worktree HEAD equal to the HEAD bound at merge/proof time). When that proof is present, the HEAD still matches, and the managed worktree is clean, the path SHALL remove the worktree even if local-only verification reports squash-merge unreachability. The path SHALL still evaluate the shared dirty/local-only ladder once. It SHALL NOT pass operator `--force` solely to bypass unverifiable state, because `--force` also discards dirty work. When bound proof matches, park-release SHALL skip remote-tip and open-PR recoverability probes.

#### Scenario: Deploy-ready removal releases a clean tree after proven squash merge

- **WHEN** `pipeline:ready-to-deploy` removal runs for issue N
- **AND** bound merge-result proof is present for issue N, PR P, the configured base, and proven OID R
- **AND** the managed worktree is clean
- **AND** local-only verification reports squash-merge unreachability
- **THEN** the worktree SHALL be removed
- **AND** the retain log `worktree retained after ready-to-deploy (commit verification failed (git/network/auth error); check connectivity and retry)` SHALL NOT be emitted

#### Scenario: Deploy-ready removal does not force-discard a dirty tree with bound proof

- **WHEN** `pipeline:ready-to-deploy` removal runs for issue N with bound merge-result proof
- **AND** the managed worktree is dirty
- **THEN** the worktree SHALL be retained
- **AND** the reason SHALL name the dirty condition
- **AND** the reason SHALL NOT be git/network/auth

#### Scenario: Deploy-ready removal retains a post-merge local commit

- **WHEN** `pipeline:ready-to-deploy` removal runs for issue N with bound merge-result proof
- **AND** the managed worktree HEAD differs from the HEAD bound at merge/proof time
- **THEN** the worktree SHALL be retained
- **AND** the reason SHALL name the HEAD mismatch or later local work

### Requirement: Never-pushed unpublished commits SHALL classify as local-only, not squash-merge unreachability

When local-only verification observes that the remote managed head ref is absent (successful empty `ls-remote`) and commits on the managed worktree or branch are not reachable from `origin/<base>`, the shared ladder SHALL classify the result as **local-only** (hard retain) when there is no bound merge-result proof and no linked merged PR for that issue. It SHALL NOT classify that observation as squash-merge unreachability (`unverifiable`) and SHALL NOT tell the operator to `--force` because the work was squash-merged. Squash-merge unreachability SHALL remain the classification only when bound merge-result proof or a linked merged PR shows the head was published and then deleted after merge. Park-release SHALL retain the worktree in the local-only case so unpublished salvage remains recoverable.

#### Scenario: Never-pushed salvage retains as local-only

- **WHEN** park-release or remove-safety runs for issue N
- **AND** `ls-remote` for the managed branch succeeds with an empty SHA (remote head never existed or is absent)
- **AND** local HEAD commits are not reachable from `origin/<base>`
- **AND** no bound merge-result proof and no linked merged PR exist for issue N
- **THEN** the shared ladder SHALL classify the result as local-only
- **AND** park-release SHALL retain the worktree
- **AND** operator-visible text SHALL NOT contain `cannot verify all commits are merged` or `use --force to proceed if work was squash-merged`

#### Scenario: Proven squash-merge remains unverifiable

- **WHEN** the remote managed head is absent
- **AND** commits are not reachable from `origin/<base>`
- **AND** bound merge-result proof or a linked merged PR exists for that issue
- **THEN** the shared ladder SHALL still classify the result as squash-merge unreachability
- **AND** SHALL NOT reclassify a proven squash-merge as local-only unpublished work

#### Scenario: Force is not the unpublished-salvage recovery path

- **WHEN** unpublished local commits exist on the managed issue branch with no remote head and no merged PR
- **THEN** automatic park-release SHALL NOT pass operator `--force`
- **AND** SHALL NOT delete the worktree that holds the unpublished salvage or checkpoint commit

### Requirement: Remove-worktree SHALL refuse a fenced live owner

`pipeline N --remove-worktree` and `pipeline remove-worktree` SHALL refuse to remove a worktree held by a fenced live owner. A fenced live owner SHALL be the unified issue-run lock with a live PID or the live-planning marker for that repository and issue. `--force` SHALL NOT override the live-owner fence. The command SHALL remain bounded-atomic administration: it SHALL NOT take RecoverySupervisor ownership of the live run. On refusal the process SHALL exit non-zero, the worktree SHALL remain, and the live run SHALL remain owned.

#### Scenario: Live owner blocks clean removal

- **WHEN** the operator invokes `pipeline N --remove-worktree`
- **AND** a pipeline-managed worktree for issue N exists and is clean
- **AND** a fenced live owner holds the issue
- **THEN** no `git worktree remove` and no `git branch -D` SHALL be invoked
- **AND** the process SHALL exit non-zero
- **AND** the live run SHALL remain owned

#### Scenario: Force does not evict a live owner

- **WHEN** the operator invokes `pipeline N --remove-worktree --force`
- **AND** a fenced live owner holds the issue
- **THEN** the worktree SHALL NOT be removed
- **AND** the process SHALL exit non-zero
