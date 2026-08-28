## ADDED Requirements

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
