## ADDED Requirements

### Requirement: Train merge SHALL park-release through the shared bound-proof gate

After `train --merge` proves a merge-result OID is contained in the fetched configured base for issue N and PR P, the train SHALL invoke the same park-release bound-proof gate used by `/pipeline` / `pipeline single`. The train SHALL pass that bound identity (issue N, PR P, that base, that proven OID, and the worktree HEAD observed at merge/proof time) into the gate. When the managed worktree is clean and the current HEAD still matches, the train SHALL NOT keep it solely because the remote head was deleted and pre-merge commits are not reachable from the base. The train SHALL NOT emit `commit verification failed (git/network/auth error)` or tell the operator to check connectivity or retry on that proven-merge path. A dirty worktree, a worktree whose HEAD moved after merge, or a filesystem cleanup failure SHALL retain the tree, report that actual cause, and SHALL NOT change ready-to-deploy or integrated state.

The train SHALL NOT implement a train-only worktree-delete mole, a second recoverer inside `train.ts`, or merge-inside-advance. The next identical post-squash-merge case SHALL take this shared gate without a new issue.

#### Scenario: Train merge releases a clean worktree after proven squash merge

- **WHEN** `pipeline train --merge` squash-merges PR P for issue N
- **AND** the train proves merge-result OID R is contained in `origin/<base>`
- **AND** the managed worktree for issue N is clean
- **THEN** park-release SHALL remove that worktree from `worktree_root`
- **AND** train/pipeline logs SHALL NOT contain `commit verification failed (git/network/auth error)`
- **AND** the logs SHALL NOT tell the operator to check connectivity or retry

#### Scenario: Train merge retains a dirty worktree without rolling back integration

- **WHEN** `pipeline train --merge` has proven merge-result OID R in `origin/<base>` for issue N and PR P
- **AND** the managed worktree is dirty
- **THEN** the worktree SHALL remain on disk
- **AND** the retain reason SHALL name the dirty condition, not git/network/auth
- **AND** the item SHALL remain integrated / `pipeline:ready-to-deploy`

#### Scenario: Train merge retains a post-merge local commit without rolling back integration

- **WHEN** `pipeline train --merge` has proven merge-result OID R in `origin/<base>` for issue N and PR P
- **AND** the managed worktree HEAD differs from the HEAD bound at merge/proof time
- **THEN** the worktree SHALL remain on disk
- **AND** the item SHALL remain integrated / `pipeline:ready-to-deploy`

#### Scenario: Train merge does not invent a path-local remover

- **WHEN** park-release after a proven train merge is implemented
- **THEN** it SHALL call the shared bound-proof park-release gate
- **AND** it SHALL NOT add a train-only `git worktree remove` path that bypasses dirty checks or bound-proof identity
