## ADDED Requirements

### Requirement: Stages that require a managed worktree SHALL rematerialize before parking for absence

When a pre-merge or fix path requires a managed on-disk worktree to perform its work (OpenSpec archive, pre-merge autofix including residual re-entry, fix rounds that write in-tree), and the issue’s managed worktree lookup returns no worktree, the pipeline SHALL attempt to rematerialize a managed worktree from the recoverable branch tip (`origin/<pipeline/N-…>` when present) or the open pull request head before blocking the issue for a missing worktree. Rematerialize SHALL reuse the create/reclaim path (same startPoint resolution and #622 reclaim safety as `createWorktree`) and SHALL NOT force-destroy dirty workdirs or local-only unpushed commits. When rematerialize succeeds, the stage SHALL continue with the recreated worktree. When rematerialize fails, the stage SHALL block with a typed blocker kind of `worktree-missing` or `worktree-creation-failed` (or `worktree-capacity` when capacity is the refusal) and a reason that names the rematerialize failure — it SHALL NOT first-hop to a product-judgment `needs-human` park whose sole cause is a missing tree.

#### Scenario: Missing worktree rematerializes from open PR head and stage continues

- **WHEN** a scoped stage path requires a managed worktree
- **AND** on-disk lookup for the issue returns no worktree
- **AND** the open PR head (or remote branch tip) is recoverable
- **AND** rematerialize / create succeeds
- **THEN** the stage SHALL proceed using the recreated worktree path
- **AND** SHALL NOT set `blocked` solely for worktree absence

#### Scenario: Rematerialize failure blocks with typed worktree reason

- **WHEN** a scoped stage path requires a managed worktree
- **AND** on-disk lookup returns no worktree
- **AND** rematerialize fails (auth, missing branch/PR head, dirty reclaim refuse, capacity, git worktree add failure)
- **THEN** the stage SHALL block with type `worktree-missing` or `worktree-creation-failed` (or `worktree-capacity` when applicable)
- **AND** the blocking reason SHALL name the rematerialize failure
- **AND** the blocker kind SHALL NOT be bare `needs-human` for absence-only factory failure

#### Scenario: Present worktree is not force-recreated

- **WHEN** on-disk lookup already returns a managed worktree for the issue
- **THEN** the rematerialize seam SHALL NOT remove and recreate that worktree solely because a stage requires a tree
- **AND** existing dirty / cleanliness guards for that path SHALL continue to apply

#### Scenario: Dirty or local-only reclaim safety is preserved

- **WHEN** rematerialize would reclaim an existing path or same-issue managed candidate
- **AND** that candidate is dirty or has local-only (unpushed) commits (or local-only verification is unverifiable / failed)
- **THEN** rematerialize SHALL refuse without force-destroying the candidate
- **AND** the stage SHALL surface that refusal as a typed rematerialize / creation failure

---

### Requirement: Rematerialize attempts SHALL be recorded as durable run evidence

When a scoped call site attempts rematerialize (including when rematerialize is skipped because a worktree is already present, if the site evaluates the seam), the pipeline SHALL append a durable run event (`gate_result` or equivalent stage event) that records the rematerialize decision and result (`pass`, `fail`, or `skipped`) and a short reason string. Dogfood and operators SHALL be able to prove from run artifacts alone whether rematerialize ran and whether it succeeded.

#### Scenario: Successful rematerialize is recorded

- **WHEN** rematerialize creates a managed worktree and returns success
- **THEN** a run event SHALL record result `pass` for the rematerialize gate (or equivalent)

#### Scenario: Failed rematerialize is recorded

- **WHEN** rematerialize fails before the stage continues
- **THEN** a run event SHALL record result `fail` and include a reason naming the failure

#### Scenario: Already-present worktree may record skip

- **WHEN** lookup finds an existing managed worktree and rematerialize is not needed
- **THEN** the call site MAY record `skipped` with reason indicating the worktree was already present
- **AND** SHALL NOT invent a false rematerialize success event
