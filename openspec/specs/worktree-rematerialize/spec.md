# worktree-rematerialize Specification

## Purpose
TBD - created by archiving change pre-merge-rematerialize-missing-worktree. Update Purpose after archive.
## Requirements
### Requirement: Stages that require a managed worktree SHALL rematerialize before parking for absence

When a pre-merge or fix path requires a managed on-disk worktree to perform its work (OpenSpec archive, pre-merge autofix including residual re-entry, fix rounds that write in-tree), and the issue’s managed worktree lookup returns no on-disk worktree, the pipeline SHALL attempt to rematerialize a managed worktree via a single injectable `ensureManagedWorktree` seam before blocking the issue for a missing worktree.

Rematerialize SHALL:

1. Resolve the branch as `pipeline/<issueNumber>-<slug>` with `slug` from the issue title (`slugify`), matching planning’s create identity.
2. Reuse `createWorktree` startPoint resolution and #622 reclaim safety: prefer verified remote tip `origin/<pipeline/N-…>` when `ls-remote` confirms the tip and the local remote-tracking ref matches after fetch; else recover from the open pull request head (`pull/<prNumber>/head` / open-PR `head_sha`). It SHALL NOT use a stale local-only branch ref as the sole startPoint when remote/PR recovery is available or required.
3. Refuse to force-destroy dirty workdirs or local-only unpushed commits (dirty/local-only checks apply only when an existing reclaim candidate path is present; managed-root containment is preserved).
4. After a successful create, verify the recreated worktree `HEAD` equals the open-PR head SHA when an open PR exists for that branch, otherwise the verified remote tip SHA used as startPoint. A HEAD mismatch SHALL be treated as rematerialize failure (`worktree-creation-failed`). On HEAD mismatch the seam SHALL remove (or otherwise quarantine so lookup cannot classify it as present) the just-created managed worktree path when that path is under the managed worktree root, so a later re-entry cannot `skip` rematerialize and proceed archive/autofix/fix on the mismatched revision.
5. Map capacity refusals to `worktree-capacity` and other create/reclaim/auth/branch/HEAD failures to `worktree-creation-failed`. When rematerialize cannot be attempted because no recoverable remote branch or open-PR head exists, map to `worktree-missing`.

When rematerialize succeeds (`result: pass`), the stage SHALL continue with the recreated worktree. When it fails (`result: fail`), the stage SHALL block with the seam’s `blockerKind` and a reason that names the rematerialize failure — it SHALL NOT first-hop to a product-judgment `needs-human` park whose sole cause is a missing tree. When lookup already finds an on-disk managed worktree, the seam SHALL return `result: skipped` and SHALL NOT remove and recreate that worktree solely because a stage requires a tree.

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
- **THEN** the stage SHALL block with type `worktree-missing` or `worktree-creation-failed` (or `worktree-capacity` when applicable)
- **AND** the blocking reason SHALL name the rematerialize failure
- **AND** the blocker kind SHALL NOT be bare `needs-human` for absence-only factory failure

#### Scenario: Present worktree is not force-recreated

- **WHEN** on-disk lookup already returns a managed worktree for the issue
- **THEN** the rematerialize seam SHALL return `skipped` and SHALL NOT remove and recreate that worktree solely because a stage requires a tree
- **AND** existing dirty / cleanliness guards for that path SHALL continue to apply

#### Scenario: Dirty or local-only reclaim safety is preserved

- **WHEN** rematerialize would reclaim an existing path or same-issue managed candidate
- **AND** that candidate is dirty or has local-only (unpushed) commits (or local-only verification is unverifiable / failed)
- **THEN** rematerialize SHALL refuse without force-destroying the candidate
- **AND** the stage SHALL surface that refusal as a typed rematerialize / creation failure (`worktree-creation-failed`)

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

---

### Requirement: Rematerialize attempts SHALL be recorded as durable run evidence

Whenever a scoped call site evaluates `ensureManagedWorktree` and a run directory is present, the pipeline SHALL append a durable run event of type `gate_result` with gate id `worktree-rematerialize` that records the result (`pass`, `fail`, or `skipped`) and a short, bounded, non-sensitive reason string. This SHALL apply to all three results when the seam is evaluated — including `skipped` when a worktree is already present. Dogfood and operators SHALL be able to prove from run artifacts alone whether rematerialize ran and whether it succeeded.

#### Scenario: Successful rematerialize is recorded

- **WHEN** rematerialize creates a managed worktree, HEAD verification passes, and a run dir is present
- **THEN** a `gate_result` event SHALL record gate `worktree-rematerialize` and result `pass`

#### Scenario: Failed rematerialize is recorded

- **WHEN** rematerialize fails before the stage continues and a run dir is present
- **THEN** a `gate_result` event SHALL record gate `worktree-rematerialize` and result `fail`
- **AND** the reason SHALL name the failure class without sensitive material

#### Scenario: Already-present worktree records skip

- **WHEN** lookup finds an existing managed worktree, the seam returns `skipped`, and a run dir is present
- **THEN** a `gate_result` event SHALL record gate `worktree-rematerialize` and result `skipped`
- **AND** the pipeline SHALL NOT invent a false rematerialize `pass` event

#### Scenario: No run dir disables durable append only

- **WHEN** no run directory is configured
- **THEN** the seam SHALL still return the same result contract for stage control flow
- **AND** SHALL NOT require a durable event append

