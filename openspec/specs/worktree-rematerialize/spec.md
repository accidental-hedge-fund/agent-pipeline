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

### Requirement: Worktree-missing sites dispositioned transient-retryable SHALL rematerialize before parking

Worktree-missing sites dispositioned `transient-retryable` SHALL rematerialize before parking.
Production fix, pre-merge, and other stage paths that currently park with `worktree-missing`
when the managed tree is absent SHALL invoke the existing rematerialize /
`ensureManagedWorktree` seam (after dirty-work and local-only safety checks) before calling
`setBlocked` for absence. Successful rematerialization SHALL allow the stage to continue.
Failure SHALL block with the seam's typed worktree kind (`worktree-missing`,
`worktree-creation-failed`, or `worktree-capacity`) and a canonical engine-owned reason — not
bare product `needs-human`.

This requirement extends coverage to inventory-listed sites that still first-hop to
`worktree-missing` without rematerialize; it does not weaken #622 dirty/local-only reclaim
refusals.

#### Scenario: Missing tree rematerializes on a dispositioned fix path

- **WHEN** a fix path dispositioned `transient-retryable` requires a managed worktree
- **AND** on-disk lookup returns no worktree
- **AND** open-PR head or verified remote tip is recoverable and create succeeds
- **THEN** the stage SHALL continue on the rematerialized worktree
- **AND** SHALL NOT call `setBlocked` solely for the initial absence

#### Scenario: Dirty reclaim refuse stays typed

- **WHEN** rematerialize would destroy a dirty or local-only unpushed candidate
- **THEN** the seam SHALL refuse
- **AND** the stage SHALL block with a typed worktree creation failure
- **AND** SHALL NOT force-remove the candidate

#### Scenario: Capacity remains capacity

- **WHEN** rematerialize fails solely because `max_concurrent_worktrees` is saturated
- **THEN** the block kind SHALL be the capacity kind
- **AND** disposition/metrics SHALL treat it as capacity, not product judgment
)

### Requirement: Rematerialize and poisoned-tree handling SHALL be reconcile actions bound to the attempt ledger

Missing, stale, and poisoned/mismatched managed worktree handling SHALL be expressed as actions
from the worktree reconcile-and-converge surface. Rematerialize attempts that consume bounded
recovery budget SHALL claim through the stage-attempt ledger when they are recovery one-shots.
Successful rematerialize SHALL still verify HEAD/candidate currency before stages proceed. Durable
`gate_result` evidence for rematerialize remains required when a run directory is present.

#### Scenario: Missing tree rematerialize is a reconcile action

- **WHEN** a stage requires a managed worktree and none is present
- **THEN** worktree reconcile SHALL return rematerialize/recreate
- **AND** the stage SHALL attempt rematerialize before parking for absence when policy permits

#### Scenario: Poisoned tree refuses proceed-on-wrong-revision

- **WHEN** a managed worktree exists but HEAD or branch identity does not match the expected
  candidate (poisoned/mismatched)
- **THEN** reconcile SHALL not return retain-as-healthy
- **AND** stages SHALL rematerialize/repair or fail typed rather than continue on the wrong revision
  (#769 class)

#### Scenario: Bounded rematerialize attempts use the ledger when charged

- **WHEN** rematerialize is a budgeted recovery action for the current candidate
- **THEN** the attempt SHALL be claimed on the stage-attempt ledger before side effects that consume
  that budget
- **AND** restart SHALL not grant an uncharged second rematerialize for the same key

### Requirement: Rematerialize call sites SHALL accept pass and skipped success variants

Every stage path that evaluates `ensureManagedWorktree` (including design-gate, visual-gate, eval-gate, fix, pre-merge archive/autofix, and loop repair) SHALL treat the seam result as follows:

1. `result: "fail"` — park (or return a typed rematerialize failure) using the seam's `blockerKind` (`worktree-missing` | `worktree-creation-failed` | `worktree-capacity`) and a reason that names the rematerialize failure. The reason SHALL use the typed kind, not `undefined`.
2. `result: "pass"` with a non-null `worktree` — continue stage work using `worktree.path` / `worktree.slug`. SHALL NOT call `setBlocked` solely because rematerialize returned success.
3. `result: "skipped"` with a non-null `worktree` — continue stage work using that path (including races where another process recreated the tree between initial lookup and ensure). SHALL NOT treat `skipped` as failure.
4. Call sites SHALL NOT require a nonexistent success string such as `"ok"`. The only producer success values are `pass` and `skipped`.

A successful rematerialize reason (for example `recreated from open PR head …`) SHALL never appear inside a blocking reason of the form `rematerialize failed (undefined)`.

When a non-fail result is returned without a usable `worktree` path (defensive handling for type-stripped or injectable fakes), the call site MAY park as `worktree-missing` with a reason that names the returned result and states the path was missing — it SHALL NOT throw on null dereference and SHALL NOT format the reason as `failed (undefined)`.

#### Scenario: Design-gate continues after pass rematerialize

- **WHEN** design-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "pass"` with a non-null worktree and reason describing recreate from open PR head
- **THEN** design-gate SHALL continue using the returned worktree path
- **AND** SHALL NOT `setBlocked` solely for that rematerialize outcome
- **AND** the blocking reason text SHALL NOT contain `failed (undefined)`

#### Scenario: Visual-gate continues after skipped rematerialize with path

- **WHEN** visual-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "skipped"` with a non-null worktree
- **THEN** visual-gate SHALL continue using the returned worktree path for the visual command
- **AND** SHALL NOT park as `worktree-missing` solely because the result was `skipped`

#### Scenario: Eval-gate continues after pass rematerialize

- **WHEN** eval-gate requires a managed worktree and on-disk lookup returns none
- **AND** `ensureManagedWorktree` returns `result: "pass"` with a non-null worktree
- **THEN** eval-gate SHALL continue using the returned worktree path for the eval command
- **AND** SHALL NOT `setBlocked` solely for rematerialize success

#### Scenario: True fail retains typed blocker

- **WHEN** any of design-gate, visual-gate, or eval-gate calls `ensureManagedWorktree`
- **AND** the seam returns `result: "fail"` with `blockerKind` one of `worktree-missing`, `worktree-creation-failed`, or `worktree-capacity`
- **THEN** the stage SHALL park with that `blockerKind`
- **AND** the reason SHALL name the rematerialize failure using the typed kind (not `undefined`)

#### Scenario: Nonexistent ok success token is not required

- **WHEN** a rematerialize call site evaluates the seam result
- **THEN** the call site SHALL treat `pass` and `skipped` as the success vocabulary
- **AND** SHALL NOT require `result === "ok"` for continuation

