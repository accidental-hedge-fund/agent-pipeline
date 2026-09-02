## MODIFIED Requirements

### Requirement: Stages that require a managed worktree SHALL rematerialize before parking for absence

When an issue-advancement path requires a managed on-disk worktree to perform its work (planning, implementation, OpenSpec archive, pre-merge autofix including residual re-entry, fix rounds that write in-tree, review, visual, eval, shipcheck), and the workspace is missing, stale, dirty, occupied, or remotely advanced, the pipeline SHALL attempt shared materialization via a single injectable `ensureManagedWorktree` seam. Stage adapters SHALL report the seam result as an operation observation. They SHALL NOT choose lifecycle treatment for those faults.

Materialize SHALL:

1. Resolve the branch as `pipeline/<issueNumber>-<slug>` with `slug` from the issue title (`slugify`), matching planning’s create identity.
2. Reuse `createWorktree` startPoint resolution and #622 reclaim safety: prefer verified remote tip `origin/<pipeline/N-…>` when `ls-remote` confirms the tip and the local remote-tracking ref matches after fetch; else recover from the open pull request head (`pull/<prNumber>/head` / open-PR `head_sha`). It SHALL NOT use a stale local-only branch ref as the sole startPoint when remote/PR recovery is available or required.
3. Refuse to force-destroy dirty workdirs, local-only unpushed commits, or unknown/unclassified dirt (dirty/local-only/unknown checks apply only when an existing reclaim candidate path is present; managed-root containment is preserved). Unknown work SHALL be preserved or quarantined and never deleted.
4. After a successful create, verify the recreated worktree `HEAD` equals the open-PR head SHA when an open PR exists for that branch, otherwise the verified remote tip SHA used as startPoint. A HEAD mismatch SHALL be treated as rematerialize failure (`worktree-creation-failed`). On HEAD mismatch the seam SHALL remove (or otherwise quarantine so lookup cannot classify it as present) the just-created managed worktree path when that path is under the managed worktree root, so a later re-entry cannot `skip` rematerialize and proceed archive/autofix/fix on the mismatched revision. That post-create cleanup SHALL apply only to the just-created managed path from this attempt, not to unknown pre-existing work.
5. Map capacity refusals to `worktree-capacity`, occupied live-owner refusals to an occupied/waiting observation, and other create/reclaim/auth/branch/HEAD failures to `worktree-creation-failed`. When rematerialize cannot be attempted because no recoverable remote branch or open-PR head exists, map to `worktree-missing`.

When rematerialize succeeds (`result: pass`), the stage adapter SHALL continue with the recreated worktree. When it fails (`result: fail`), the adapter SHALL emit a typed operation observation with the seam’s `blockerKind` and a reason that names the rematerialize failure. RecoverySupervisor SHALL own treatment, Cooling, or wait. The lifecycle projector MAY emit a blocked label. The adapter SHALL NOT first-hop to a product-judgment `needs-human` park whose sole cause is a missing tree, and SHALL NOT declare the Logical Operation complete, cancelled, or human-owned. When lookup already finds an on-disk managed worktree whose HEAD matches the intended candidate and that is not occupied by a live owner, the seam SHALL return `result: skipped` and SHALL NOT remove and recreate that worktree solely because a stage requires a tree.

#### Scenario: Missing worktree rematerializes from open PR head and stage continues

- **WHEN** a scoped stage path requires a managed worktree
- **AND** on-disk lookup for the issue returns no worktree
- **AND** the open PR head (or verified remote branch tip) is recoverable
- **AND** rematerialize / create succeeds and HEAD matches the intended tip SHA
- **THEN** the stage SHALL proceed using the recreated worktree path
- **AND** SHALL NOT set `blocked` solely for worktree absence

#### Scenario: Rematerialize failure blocks with typed worktree reason

- **WHEN** a scoped stage path requires a managed worktree
- **AND** on-disk lookup returns no worktree
- **AND** rematerialize fails (auth, missing branch/PR head, dirty reclaim refuse, capacity, git worktree add failure, HEAD mismatch)
- **THEN** the adapter SHALL emit an observation with type `worktree-missing` or `worktree-creation-failed` (or `worktree-capacity` when applicable)
- **AND** the reason SHALL name the rematerialize failure
- **AND** the observation SHALL NOT be a bare `needs-human` Authority Request for absence-only factory failure
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Present worktree is not force-recreated

- **WHEN** on-disk lookup already returns a managed worktree for the issue
- **AND** HEAD matches the intended candidate
- **AND** no live owner occupies the tree
- **THEN** the rematerialize seam SHALL return `skipped` and SHALL NOT remove and recreate that worktree solely because a stage requires a tree
- **AND** existing dirty / cleanliness guards for that path SHALL continue to apply

#### Scenario: Dirty or local-only reclaim safety is preserved

- **WHEN** rematerialize would reclaim an existing path or same-issue managed candidate
- **AND** that candidate is dirty or has local-only (unpushed) commits (or local-only verification is unverifiable / failed)
- **THEN** rematerialize SHALL refuse without force-destroying the candidate
- **AND** the adapter SHALL surface that refusal as a typed rematerialize / creation observation (`worktree-creation-failed`)
- **AND** RecoverySupervisor SHALL retain ownership

#### Scenario: Stale manager metadata without on-disk path is treated as missing

- **WHEN** manager/metadata records suggest a worktree but no on-disk managed path exists for the issue
- **THEN** the seam SHALL treat the worktree as missing and attempt rematerialize
- **AND** SHALL NOT treat metadata alone as a present worktree

#### Scenario: HEAD mismatch after create fails rematerialize

- **WHEN** `createWorktree` returns a path but worktree `HEAD` does not equal the open-PR head SHA (or verified remote tip SHA)
- **THEN** the seam SHALL return `result: fail` with `blockerKind: worktree-creation-failed`
- **AND** the stage SHALL NOT continue archive/autofix/fix on the mismatched tree
- **AND** when the created path is under the managed worktree root, the seam SHALL remove or quarantine that path so subsequent on-disk lookup does not treat it as a valid present worktree

#### Scenario: HEAD-mismatch leftover does not skip on re-entry

- **WHEN** a prior rematerialize attempt failed post-create HEAD verification and cleaned up the mismatched managed path
- **AND** the pipeline re-enters a scoped stage that calls `ensureManagedWorktree`
- **THEN** on-disk lookup SHALL NOT classify the former mismatched path as present solely from that failed create
- **AND** the seam SHALL NOT return `skipped` for that stale mismatched tree
- **AND** rematerialize SHALL be attempted again (or fail typed) rather than proceeding archive/autofix/fix on the wrong revision

#### Scenario: Occupied workspace waits without stealing

- **WHEN** a live process owns the issue-run lock or live-planning marker for the issue
- **THEN** `ensureManagedWorktree` SHALL refuse to steal the workspace
- **AND** the adapter SHALL emit an occupied/waiting observation
- **AND** RecoverySupervisor SHALL retain ownership as an external-condition wait

#### Scenario: Remotely advanced workspace is not used as the old candidate

- **WHEN** on-disk lookup finds a managed worktree
- **AND** the open PR head or verified remote tip differs from worktree HEAD
- **THEN** the seam SHALL NOT skip as a present matching candidate
- **AND** SHALL rematerialize or fail typed
- **AND** candidate-bound evidence from the prior HEAD SHALL be invalid

## ADDED Requirements

### Requirement: Shared materialization SHALL be the only issue-stage workspace recovery path

Issue-advancement stages SHALL route missing, stale, dirty, occupied, and remotely advanced workspace faults through `ensureManagedWorktree` (or a thin facade that delegates to it). A stage-local rematerialize, destroy, or block path that bypasses that seam SHALL fail a contract test.

#### Scenario: Stage-local rematerialize bypass fails the contract

- **WHEN** a delivery-stage module creates, removes, or parks for worktree absence without calling `ensureManagedWorktree`
- **THEN** a contract test SHALL fail
- **AND** SHALL name the module
