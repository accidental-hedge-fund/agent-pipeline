# harness-mutation-ownership Specification

## Purpose
Persist mutation ownership for product-mutating harness attempts so a later process can tell pipeline-owned leftovers from unknown product dirt, checkpoint the owned set, and resume without an operator reconstructing authorship.

## Requirements

### Requirement: Product-mutating harness attempts SHALL persist durable mutation ownership before spawn

The engine SHALL write a durable mutation-ownership record for every product-mutating harness attempt (implement, fix-round, test-fix, and pre-merge auto-fix) **before** the harness child is spawned. The record SHALL include at least: schema version, issue identity, stage, attempt identity, managed worktree path, pre-attempt HEAD, and pre-attempt product porcelain (path identity sufficient to detect later adds, deletes, and content changes). Untracked porcelain in ownership snapshots and current-status reads SHALL be recorded at file granularity (`git status --porcelain --untracked-files=all` or equivalent). The engine SHALL NOT treat an untracked directory as a single owned path. The write SHALL be durable across process exit (host-local run-store or equivalent run artifact, not in-memory only). The attempt SHALL be marked in-flight until the engine clears that flag after the attempt completes with no owned leftovers. The engine SHALL NOT spawn the harness when the pre-attempt record cannot be made durable; in that case it SHALL fail closed without claiming later dirt as owned.

#### Scenario: Pre-snapshot exists before the implement harness runs

- **WHEN** the pipeline is about to invoke the implement harness for issue N in a managed worktree
- **THEN** a durable ownership record for that attempt SHALL already contain the pre-attempt HEAD and pre-attempt porcelain
- **AND** the harness child SHALL NOT have been spawned before that record is durable

#### Scenario: Ownership hydrates in a new process

- **WHEN** the process that spawned the harness exits
- **AND** a later launcher re-enters the same issue
- **THEN** the later process SHALL load the same attempt identity, pre-HEAD, and pre-porcelain
- **AND** SHALL NOT reconstruct ownership from in-memory state of the dead process

#### Scenario: Failed pre-snapshot does not spawn and does not claim ownership

- **WHEN** the engine cannot durable-write the pre-attempt record
- **THEN** it SHALL NOT spawn the harness
- **AND** SHALL NOT classify later product dirt as pipeline-owned leftovers for that attempt

#### Scenario: Untracked directory snapshot is file-granular

- **WHEN** a harness creates untracked file `dir/owned.ts` in a new directory
- **AND** a later process observes additional untracked file `dir/unrelated.ts` in the same directory
- **THEN** the owned leftover set SHALL include `dir/owned.ts`
- **AND** SHALL NOT include `dir/unrelated.ts`
- **AND** the checkpoint SHALL stage `dir/owned.ts` and SHALL NOT stage `dir/unrelated.ts`
- **AND** the engine SHALL NOT re-invoke a product-mutating harness while `dir/unrelated.ts` remains unknown product dirt

---

### Requirement: Interrupted attempts SHALL refresh last-known porcelain and classify leftovers versus unknown dirt

While a product-mutating harness is in-flight, the engine SHALL refresh last-known porcelain on a bounded heartbeat and SHALL write a post-attempt snapshot on the timeout or crash path when the process can still run. A heartbeat refresh that loaded the in-flight record SHALL NOT persist after the attempt has been finalized (`in_flight` cleared, or a post-attempt snapshot / result class written). The engine SHALL serialize in-flight heartbeat writes with the finish path and SHALL await an active refresh on heartbeat stop so a refresh started before completion cannot resurrect `in_flight` ownership or claim later operator dirt as owned. Pipeline-owned leftovers SHALL be the product-path porcelain delta in the last-known or post snapshot versus the pre-attempt snapshot. Product paths that are dirty now and are not in that owned set SHALL be unknown product dirt. Engine-known scratch SHALL remain scratch and SHALL NOT be classified as owned leftovers. When no ownership record exists, the owned set SHALL be empty and product dirt SHALL be unknown. When the process is killed after a durable pre-snapshot but before any last-known refresh, the engine SHALL treat current product porcelain that is not already present in the pre-attempt product snapshot as owned for that interrupted attempt. Product paths already present in the pre-attempt snapshot SHALL remain unknown product dirt unless durable content evidence proves they changed during the attempt.

#### Scenario: Timeout after product edits yields owned leftovers

- **WHEN** the pre-attempt porcelain is clean
- **AND** the implement harness modifies tracked product files and times out before a final commit
- **AND** last-known or post porcelain lists those product paths
- **THEN** those paths SHALL be classified as pipeline-owned leftovers
- **AND** SHALL NOT be classified as unknown product dirt

#### Scenario: Timeout after an intermediate commit plus later edits yields owned leftovers

- **WHEN** the implement harness creates a commit and then modifies further product files
- **AND** the harness times out with those later files uncommitted
- **THEN** the uncommitted product files in the last-known or post delta SHALL be pipeline-owned leftovers
- **AND** the intermediate commit SHALL remain on the branch

#### Scenario: Operator dirt after a post-snapshot is unknown

- **WHEN** a post-attempt or last-known snapshot has been written
- **AND** a later process observes additional dirty product paths that are not in that snapshot
- **THEN** those additional paths SHALL be unknown product dirt
- **AND** SHALL NOT be classified as pipeline-owned leftovers

#### Scenario: Missing ownership record is unknown dirt

- **WHEN** a dirt-trust gate observes product porcelain
- **AND** no durable ownership record exists for the current worktree attempt
- **THEN** the owned leftover set SHALL be empty
- **AND** that product porcelain SHALL be unknown product dirt

#### Scenario: Stale heartbeat does not overwrite a completed record

- **WHEN** an in-flight heartbeat refresh has loaded the in-flight record
- **AND** the finish path has persisted `in_flight` false or a post-attempt snapshot
- **THEN** the stale refresh SHALL NOT persist over the completed record
- **AND** SHALL NOT add later operator product paths to the owned leftover set

#### Scenario: Scratch is not owned leftover

- **WHEN** porcelain lists only engine-known non-product scratch
- **THEN** classification SHALL treat those paths as scratch
- **AND** SHALL NOT treat them as pipeline-owned leftovers or unknown product dirt

#### Scenario: Hard-kill with pre-existing product dirt stays fail-closed

- **WHEN** the durable pre-attempt snapshot already lists product path `U`
- **AND** the process is killed after that pre-snapshot but before any last-known refresh
- **AND** current porcelain lists `U` and a newly dirty product path `P` that was not in the pre-snapshot
- **THEN** `P` SHALL be classified as a pipeline-owned leftover
- **AND** `U` SHALL remain unknown product dirt
- **AND** a checkpoint SHALL include `P` and SHALL NOT include `U`

---

### Requirement: The engine SHALL checkpoint owned leftovers before dirt-trust unknown-dirt refusal

When a later process (or the same process on the timeout path) observes pipeline-owned leftovers, the engine SHALL checkpoint those owned paths into a commit using the existing salvage authorship rules (salvage subject prefix, `Issue:` and `Pipeline-Run:` trailers, depth-agnostic `node_modules` exclusion, pipeline-internal marker exclusion) **scoped to the owned path set**. The engine SHALL NOT include unknown product dirt or engine-known scratch in that checkpoint. After checkpoint, the engine SHALL clear owned leftovers for those paths and SHALL emit terminal evidence with disposition `checkpointed` or `recovered`. The engine SHALL NOT require an operator to inspect or commit those owned paths. When checkpoint fails and owned leftovers remain, the engine SHALL preserve the existing ownership record, SHALL NOT spawn another product-mutating harness for that attempt, SHALL NOT fall through to unscoped salvage, and SHALL treat the residual as `harness-failure` (workflow-engine-defect recover).

#### Scenario: Retry checkpoints owned leftovers without operator action

- **WHEN** a new `/pipeline N` (or equivalent single/loop re-entry) finds owned leftovers from an interrupted implement attempt
- **THEN** the engine SHALL create a checkpoint commit containing those owned product paths
- **AND** SHALL NOT block with a pre-existing-uncommitted-changes unknown-dirt reason solely for those paths
- **AND** SHALL NOT require an operator commit

#### Scenario: Mixed owned leftovers and unknown dirt checkpoints only owned paths

- **WHEN** porcelain includes owned leftover path `P` and unknown product path `U`
- **THEN** the checkpoint commit SHALL include `P`
- **AND** SHALL NOT include `U`
- **AND** unknown-dirt refusal SHALL apply to `U` after the checkpoint
- **AND** the engine SHALL NOT re-invoke a product-mutating harness while `U` remains unknown product dirt

#### Scenario: Same-process timeout checkpoints when the process can still run

- **WHEN** the implement harness returns timeout and owned leftovers are present
- **THEN** the engine SHALL checkpoint those owned paths before returning a dirt-trust unknown-dirt block
- **AND** if the checkpoint leaves no unknown product dirt, the unknown-dirt block SHALL NOT fire for that leftover set

#### Scenario: Failed scoped checkpoint does not fall through to unscoped salvage

- **WHEN** checkpoint of owned leftover path `P` fails
- **AND** unknown product path `U` is also dirty
- **THEN** the engine SHALL NOT run unscoped salvage
- **AND** SHALL NOT include `U` in a salvage commit
- **AND** the durable ownership record SHALL keep the original attempt identity and owned leftover set
- **AND** the residual block SHALL be `harness-failure`

#### Scenario: Failed checkpoint preserves ownership and does not re-invoke

- **WHEN** checkpoint of owned leftovers fails
- **AND** owned leftovers remain
- **THEN** the durable ownership record SHALL keep the original attempt identity and owned leftover set
- **AND** the engine SHALL NOT begin a new ownership attempt that would place those leftovers in pre-porcelain
- **AND** the residual block SHALL be `harness-failure`

---

### Requirement: Terminal evidence SHALL name recover, checkpoint, resume, or reject

Every ownership classification that drives a recover, checkpoint, resume, or unknown-dirt reject SHALL record structured terminal evidence that identifies exactly one disposition among `recovered`, `checkpointed`, `resumed`, and `rejected`. Rejected evidence SHALL disclose the unknown product paths. The evidence SHALL be durable in the run-store (or equivalent) so `pipeline summary` / stage outcome can show it.

#### Scenario: Rejected unknown dirt is named

- **WHEN** a dirt-trust gate refuses because unknown product dirt remains
- **THEN** terminal evidence disposition SHALL be `rejected`
- **AND** the unknown product paths SHALL be disclosed

#### Scenario: Successful leftover recovery is named

- **WHEN** owned leftovers are checkpointed and the item continues without an unknown-dirt block on those paths
- **THEN** terminal evidence disposition SHALL be `checkpointed` or `recovered`

#### Scenario: Interrupted implement is re-invoked

- **WHEN** after checkpoint the implement deliverable is not yet satisfied and the engine re-invokes the implementer
- **THEN** terminal evidence disposition SHALL be `resumed`

---

### Requirement: Ownership classification and checkpoint SHALL be injectable for unit tests

The ownership record, leftover-vs-unknown classifier, and checkpoint path SHALL accept dependency seams so unit tests can inject fake porcelain, fake durable storage, and fake git without real network, git, or subprocess calls. The test suite SHALL cover: timeout after product edits with no intermediate commit; timeout after an intermediate commit plus later edits; retry recovery in a new process; unrelated-dirt refusal; missing-ownership fail-closed; hard-kill with pre-existing product dirt.

#### Scenario: Timeout after product edits is a biting regression

- **WHEN** a hermetic test presents a timed-out implement attempt with product porcelain versus a clean pre-snapshot
- **AND** the ownership/checkpoint wiring is removed
- **THEN** the test SHALL fail by observing unknown-dirt refusal of those leftovers

#### Scenario: Unrelated dirt still refuses

- **WHEN** a hermetic test presents product dirt with no ownership record, or extra product paths after a post-snapshot
- **THEN** the classifier SHALL report unknown product dirt
- **AND** the dirt-trust path SHALL refuse auto-fix of those paths

#### Scenario: Hard-kill with pre-existing dirt is a biting regression

- **WHEN** a hermetic test presents an in-flight attempt with no last-known or post snapshot, pre-attempt product path `U`, and current porcelain listing `U` plus a new product path `P`
- **AND** the hard-kill fallback claims every current product path as owned
- **THEN** the test SHALL fail by observing `U` in the owned leftover set or in the checkpoint path set

#### Scenario: New-process hydration is tested without a live harness

- **WHEN** a test writes a durable ownership record, discards in-memory state, and reloads
- **THEN** leftover classification SHALL match the stored pre/last-known porcelain
- **AND** SHALL NOT depend on a still-running harness process

### Requirement: A successful same-process checkpoint SHALL be eligible for post-implement publish

When the same process observes a harness timeout (or equivalent harness failure) and ownership checkpoint authored a salvage-equivalent commit, and porcelain is then clean of unknown product dirt, the engine SHALL treat that checkpoint as recovered work for the unpublished-stage-commit-publish classifier. The engine SHALL NOT park as terminal `harness-failure` solely because the harness timed out, and SHALL NOT require the legacy unscoped salvage helper to have set `salvaged` in order to proceed. When the implement deliverable is satisfied, the engine SHALL enter the post-implement publish path defined by `unpublished-stage-commit-publish`. When the deliverable is unsatisfied, existing completeness (re-invoke implementer) SHALL still apply. Failed checkpoint with remaining owned leftovers SHALL remain `harness-failure` as already specified.

#### Scenario: Timeout after checkpoint does not park solely on timed-out

- **WHEN** the implement harness returns timeout
- **AND** ownership checkpoint creates a salvage-equivalent commit
- **AND** the worktree is then clean of unknown product dirt
- **AND** the implement deliverable is satisfied
- **THEN** the engine SHALL NOT `setBlocked` solely with reason `timed out after <N>s`
- **AND** SHALL proceed to post-implement publish (gates → push → PR → `review-1`)

#### Scenario: Legacy salvaged flag is not required after checkpoint

- **WHEN** ownership checkpoint already authored the owned leftovers
- **AND** the legacy unscoped salvage helper is skipped so its `salvaged` result is false
- **THEN** the engine SHALL still treat the checkpoint commit as salvage-equivalent recovered work
- **AND** SHALL NOT take the `!salvaged` timeout-block path

#### Scenario: Failed checkpoint still parks as harness-failure

- **WHEN** ownership checkpoint fails and owned leftovers remain
- **THEN** the residual block SHALL remain `harness-failure`
- **AND** the engine SHALL NOT publish or transition to `review-1`
