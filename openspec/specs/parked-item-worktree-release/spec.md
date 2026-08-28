# parked-item-worktree-release Specification

## Purpose
TBD - created by archiving change release-blocked-worktrees-on-hold. Update Purpose after archive.

## Requirements

### Requirement: Durable park SHALL release a safe managed worktree

When an issue reaches a durable non-transient park or hold — an advance outcome that leaves the issue waiting without further harness execution in its managed worktree (including needs-human holds and non-immediately-recoverable blocked outcomes) — the pipeline SHALL attempt to release that issue's managed worktree. Release SHALL succeed only when the worktree path is under a managed root, the working tree is clean, and **one** recoverability condition holds:

1. local-only commit verification reports no unpushed commits, **and** the branch tip is present on the remote **or** an open PR with a resolvable head SHA exists for that head branch (so resume can reconstruct from that commit); **or**
2. the engine holds **bound merge-result proof** for this same issue: the same issue number, the same PR number, the same configured base branch, a `merge_result_oid` the engine has proven is contained in `origin/<base>` for that identity, and the managed worktree HEAD still equals the HEAD bound on that proof at merge/proof time.

On successful release the worktree directory SHALL be deregistered and removed from disk so it no longer appears in the on-disk listing used by capacity counting; the remote branch and any open PR SHALL NOT be deleted by release. Release logic SHALL reuse the same dirty and local-only safety ladder as operator remove / create reclaim (no automatic force discard). Bound merge-result proof SHALL authorize release of a clean tree even when the remote head branch is already deleted and pre-merge commits are not reachable from the base (the usual squash-merge SHA mismatch). When bound proof matches, park-release SHALL NOT require remote-tip or open-PR lookups to succeed and SHALL NOT invoke those probes. Bound proof SHALL NOT authorize discarding a dirty worktree. Bound proof SHALL NOT authorize release when the current worktree HEAD differs from the HEAD bound at merge/proof time.

#### Scenario: Clean parked worktree with remote branch is released

- **WHEN** issue N durable-parks and its managed worktree is clean, has no local-only commits, and branch tip exists on the remote
- **THEN** the pipeline SHALL remove that managed worktree from disk and deregister it
- **AND** the remote branch SHALL remain
- **AND** a subsequent capacity count SHALL NOT include a worktree for issue N

#### Scenario: Clean parked worktree with open PR is released

- **WHEN** issue N durable-parks and its managed worktree is clean with no local-only commits
- **AND** an open PR with a resolvable head SHA exists for the pipeline head branch even if remote-tip verification is otherwise marginal
- **THEN** the pipeline SHALL release the managed worktree without deleting the PR or remote branch

#### Scenario: Clean parked worktree with bound merge-result proof is released after squash merge

- **WHEN** issue N's PR P was squash-merged onto the configured base branch
- **AND** the engine has proven `merge_result_oid` R is contained in `origin/<base>` for that same N, P, and base
- **AND** the managed worktree for issue N is clean
- **AND** the remote head branch is deleted and pre-merge commits are not reachable from the base
- **THEN** the pipeline SHALL remove that managed worktree from disk and deregister it
- **AND** operator-visible text SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** operator-visible text SHALL NOT tell the operator to check connectivity or retry

#### Scenario: Bound-proof release does not probe remote tip or open PR

- **WHEN** issue N durable-parks with bound merge-result proof for N, PR P, the configured base, proven OID R, and matching worktree HEAD
- **AND** the managed worktree is clean
- **THEN** park-release SHALL release that worktree
- **AND** SHALL NOT invoke remote-tip or open-PR recoverability probes
- **AND** a failure of those probes SHALL NOT retain the worktree

#### Scenario: Post-merge local commit is retained despite bound proof

- **WHEN** issue N's PR P was squash-merged with bound merge-result proof
- **AND** the managed worktree HEAD differs from the HEAD bound at merge/proof time
- **THEN** the pipeline SHALL retain that worktree
- **AND** SHALL NOT remove it on the strength of bound proof

#### Scenario: Out-of-managed-root worktree is never auto-released

- **WHEN** issue N has a worktree record with `underManagedRoot === false`
- **AND** issue N durable-parks
- **THEN** the pipeline SHALL NOT remove that worktree via park-release

### Requirement: Unsafe park SHALL retain the worktree with a visible reason

When durable park would release a worktree but any safety precondition fails — dirty working tree, definitive local-only commits, unverifiable or failed local-only verification **without bound merge-result proof**, or neither remote branch tip nor open PR with resolvable head **and no bound merge-result proof** — the pipeline SHALL retain the worktree on disk, SHALL NOT force-delete it, and SHALL surface a retain reason to the operator (run log and/or blocker/hold text) so capacity occupancy is explainable.

When the remote head branch is deleted and pre-merge commits are not reachable from the configured base, and bound merge-result proof is absent, the retain reason SHALL name that commits are not reachable from the base (the existing squash-merge / `--force` wording). That reason SHALL NOT state `commit verification failed (git/network/auth error)` and SHALL NOT tell the operator to check connectivity or retry.

Bound merge-result proof SHALL NOT convert a dirty worktree or a filesystem/cleanup failure into an automatic discard.

#### Scenario: Dirty worktree is retained on park

- **WHEN** issue N durable-parks and `git status --porcelain` in its managed worktree is non-empty
- **THEN** the worktree SHALL remain on disk
- **AND** the operator-visible retain reason SHALL name the dirty condition

#### Scenario: Local-only commits retain the worktree

- **WHEN** issue N durable-parks and local-only commit verification reports definitive unpushed commits
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name the local-only condition

#### Scenario: Missing remote recoverability retains the worktree

- **WHEN** issue N durable-parks and the branch tip is not on the remote and no open PR with resolvable head exists for that head
- **AND** the engine does not hold bound merge-result proof for issue N
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name missing remote/PR recoverability

#### Scenario: Squash-merge unreachability without bound proof retains with the not-reachable reason

- **WHEN** issue N durable-parks
- **AND** the remote head branch is deleted
- **AND** pre-merge commits are not reachable from the configured base (or that reachability check cannot prove they are in the base)
- **AND** the engine does not hold bound merge-result proof for issue N, PR P, that base, and a proven `merge_result_oid`
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name that commits are not reachable from the base
- **AND** the retain reason SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** the retain reason SHALL NOT tell the operator to check connectivity or retry

### Requirement: Resume after release SHALL recreate via the normal create path

When an issue whose managed worktree was park-released is advanced again (unblock, re-run, or durable resume) **and the current stage requires a managed worktree** (planning / implementing bootstrap, or any earlier stage that executes in the worktree), the pipeline SHALL obtain a worktree through the existing `createWorktree` / planning bootstrap path. Same-issue reclaim and the rule that the current issue does not count against `max_concurrent_worktrees` for its own create SHALL remain in force. Park-release SHALL NOT invent a separate branch or worktree naming scheme. When the remote branch tip is absent but an open PR head SHA is available, `createWorktree` SHALL start from that PR head (fetching it) rather than from `origin/<base_branch>` alone.

When the current stage is at or after `pre-merge` and the run does not need a managed worktree for harness work, the pipeline SHALL NOT rematerialize a worktree solely so trusted-surface or ready-to-deploy can resolve a candidate SHA. Candidate SHA resolution on that path SHALL follow `trusted-surface-rebind` (linked open PR head matching the last-advanced candidate, or an explicit candidate-SHA override). Park-release safety and retain rules SHALL stay unchanged.

#### Scenario: Re-advance after release creates a new worktree

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` (or equivalent bootstrap) SHALL create a managed worktree for issue N
- **AND** same-issue capacity exclusion SHALL still apply so issue N does not block itself

#### Scenario: Resume after PR-only release reconstructs at PR head

- **WHEN** issue N was park-released because an open PR with resolvable head SHA existed and the remote branch tip was absent
- **AND** the pipeline advances issue N again at a stage that requires a managed worktree
- **THEN** `createWorktree` SHALL use the open PR head (not only `origin/<base_branch>`) as the worktree start point

#### Scenario: Late-stage re-entry does not rematerialize solely for trusted-surface

- **WHEN** issue N was park-released (no managed worktree on disk)
- **AND** the pipeline re-enters issue N at or after `pre-merge`
- **AND** a linked open PR head matches the last-advanced candidate (or an explicit candidate-SHA override is present)
- **THEN** the pipeline SHALL NOT create a managed worktree solely to satisfy trusted-surface or ready-to-deploy candidate SHA resolution
- **AND** trusted-surface SHALL still resolve `candidate_sha` from that PR head or override

#### Scenario: Idempotent release when already absent

- **WHEN** durable park runs for issue N and no managed worktree is on disk
- **THEN** park-release SHALL be a no-op success
- **AND** SHALL NOT fail the park outcome solely because the worktree is already absent

### Requirement: Parked worktree release SHALL evaluate remove safety once

`releaseWorktreeForParkedIssue` (and equivalent parked-release helpers) SHALL evaluate the shared
remove-safety policy exactly once per release decision via `evaluateRemoveSafety` or a single
wrapper that does. The path SHALL NOT run two independent full-policy evaluations that can disagree
or double-apply mutations. Unsafe results retain the worktree with a visible reason as already
required.

#### Scenario: Single safety evaluation per park release

- **WHEN** parked release runs for an issue with a managed worktree
- **THEN** `evaluateRemoveSafety` (or the shared wrapper's evaluation) SHALL run once for that
  decision
- **AND** the release SHALL not invoke a second independent full-policy preflight that can authorize
  a different outcome

#### Scenario: Unsafe park retains the worktree

- **WHEN** the single safety evaluation returns a blocking dirty or local-only result without force
- **THEN** the worktree SHALL be retained
- **AND** the visible park reason SHALL name the unsafe condition

### Requirement: Bound merge-result proof SHALL be a runtime-validated in-process carrier

Park-release SHALL accept bound merge-result proof only as a runtime-validated `VerifiedMergeProof` object that names this issue number, this PR number, the configured base branch, the merge-result OID, and the managed worktree HEAD observed at merge/proof time together. The engine SHALL create that object only after the in-base verifier has fetched `origin/<base>` successfully and proven the OID is contained in that fetched ref. A failed fetch SHALL NOT mint proof from a stale local `origin/<base>` tracking ref. Park-release SHALL NOT reconstruct proof from run logs, GitHub labels, issue comments, or untyped persisted data.

#### Scenario: Proof is not reconstructed from logs or labels

- **WHEN** park-release runs
- **AND** the only available merge evidence is a train log line, a GitHub label, or untyped persisted JSON
- **AND** no in-process `VerifiedMergeProof` from the in-base verifier exists
- **THEN** park-release SHALL NOT treat that evidence as bound proof
- **AND** SHALL NOT release the worktree on that evidence alone

#### Scenario: Failed base fetch does not mint proof from stale refs

- **WHEN** the in-base verifier fetches `origin/<base>` and the fetch exits non-zero
- **AND** a stale local `origin/<base>` tracking ref still contains the merge-result OID
- **THEN** the engine SHALL NOT create a `VerifiedMergeProof`
- **AND** park-release SHALL retain the worktree

### Requirement: Bound merge-result proof SHALL match issue, PR, base, and OID

Park-release SHALL treat merge-result proof as bound only when it names this issue number, this PR number, this configured base branch, and this verified merge-result OID together, and the current managed worktree HEAD equals the HEAD stored on that proof. Proof for a different issue, a different PR, a different base branch, a different OID, or a different worktree HEAD SHALL NOT authorize release of this worktree.

#### Scenario: Proof for another issue does not release this worktree

- **WHEN** the engine holds proven `merge_result_oid` R for issue M and PR Q
- **AND** park-release runs for issue N with PR P (N ≠ M or P ≠ Q)
- **AND** issue N's managed worktree is otherwise in the post-squash-merge unreachability state
- **THEN** park-release SHALL NOT remove issue N's worktree on the strength of M/Q's proof

#### Scenario: Proof for another base or OID does not release this worktree

- **WHEN** park-release runs for issue N and PR P on configured base `develop`
- **AND** the only available proof is a `merge_result_oid` proven on a different base, or a different OID than the one proven contained in `origin/develop` for N and P
- **THEN** park-release SHALL NOT remove the worktree on that unmatched proof

#### Scenario: Proof for another worktree HEAD does not release this worktree

- **WHEN** park-release runs for issue N and PR P with bound proof whose `worktreeHead` is SHA H
- **AND** the managed worktree HEAD is a different SHA
- **THEN** park-release SHALL NOT remove the worktree on that unmatched HEAD

### Requirement: Filesystem cleanup failure after proven merge SHALL keep the worktree and the pipeline state

Park-release SHALL treat on-disk removal after a proven merge as best-effort. If filesystem or git-worktree cleanup fails after bound merge-result proof is present, park-release SHALL keep only that worktree, SHALL report the actual filesystem or cleanup error, SHALL NOT report git/network/auth, and SHALL NOT change `pipeline:ready-to-deploy` or integrated state for that issue.

#### Scenario: Cleanup error after proven merge retains the tree and labels

- **WHEN** bound merge-result proof is present for issue N and PR P
- **AND** the managed worktree is clean
- **AND** the remove operation fails with a filesystem or git-worktree cleanup error
- **THEN** that worktree SHALL remain on disk
- **AND** the operator-visible reason SHALL name the filesystem or cleanup error
- **AND** the reason SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** issue N SHALL remain `pipeline:ready-to-deploy` (or integrated, if already recorded) without a label or integration rollback

### Requirement: A dirty worktree after proven merge SHALL be retained with the dirty cause

Park-release SHALL keep a managed worktree that is not clean after a proven merge. The retain reason SHALL name the dirty-worktree cause. The reason SHALL NOT report git/network/auth. Park-release SHALL NOT change `pipeline:ready-to-deploy` or integrated state.

#### Scenario: Dirty tree after proven merge is kept

- **WHEN** bound merge-result proof is present for issue N and PR P
- **AND** `git status --porcelain` in the managed worktree is non-empty
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name the dirty condition
- **AND** the retain reason SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** `pipeline:ready-to-deploy` and integrated state SHALL NOT change because of the retain

### Requirement: The same bound-proof park-release gate SHALL apply to pipeline single and train merge

Park-release after `/pipeline` / `pipeline single` and after `train --merge` SHALL use the same bound-proof release gate. A later identical post-squash-merge case SHALL take that gate without a new mole issue or a caller-specific exception.

#### Scenario: Pipeline single and train merge share the gate

- **WHEN** issue N is squash-merged with bound merge-result proof and a clean managed worktree
- **AND** park-release runs from `/pipeline` / `pipeline single` or from `train --merge`
- **THEN** both callers SHALL release the worktree under the same bound-proof rule
- **AND** neither caller SHALL emit git/network/auth wording for that proven-merge path
